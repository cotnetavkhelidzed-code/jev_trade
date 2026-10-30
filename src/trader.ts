import { appendFileSync, mkdirSync } from "node:fs";
import { Strategy, Markouts, volatilityBps, type Gate } from "./strategy";
import { RULEBOOK } from "./rulebook";
import { config } from "./config";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated): set when the block is emitted if they were already seen, else when their trade logs arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
  strategy?: Gate | null;
  account?: { block: number; mon: number; usdc: number; equityUsd: number; pnlUsd: number; vsHoldUsd: number } | null;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  /** Blocks whose order was already resting where it should be: nothing sent, no gas. */
  kept: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  tradingFeesUsd?: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

interface Resting { queue?: number; side: Side; price: number; size: number; block: number; txHash: string | null }

/** Fill-before-receipt sizes kept at most (old entries are for orders we will never hear about again). */
const EARLY_FILLS_KEPT = 500;

/**
 * Every block: read the book and ask the model buy or sell. If the one order we have resting is on that
 * side and still at the touch, it stays and nothing is sent; otherwise post one post-only limit order on
 * that side (`quoteInsideTicks` inside the other makers' touch), cancelling whatever we had resting.
 * (`QUOTE_EVERY_BLOCK=true` posts a new order every block.) One request in flight; a block that arrives
 * while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 *
 * Receipts and trade logs arrive on their own schedule (and from different RPCs), so the books here
 * never assume an order: a fill may beat the receipt that placed its order, an update may be built
 * while the one before it is unconfirmed, and a fill may print in the block still being decided.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private head = 0;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Orders we know are resting on the book (live: from receipts; dry run: last block's simulated order). */
  private orders = new Map<number, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  /** Remaining size of orders whose fills reached us before the receipt that placed them. */
  private earlyFills = new Map<number, number>();
  /** Fills printed in a block whose event is not out yet; they go out with it. */
  private pendingFills = new Map<number, Fill[]>();
  private strategy = new Strategy({ horizon: config.horizonBlocks, minSamples: config.strategyMinSamples, minFills: config.strategyMinFills, minEdgeUsd: config.minEdgeUsd, uncertainty: config.edgeUncertainty, exitBps: config.exitCostBps, maxLossUsd: config.maxLossUsd, maxVolBps: config.maxVolBps });
  private markouts = new Markouts();
  private gate: Gate | null = null;
  private observedPrints: TradePrint[] = [];
  private feesUsd = 0;
  private account: { block: number; mon: number; usdc: number; mid: number; inferenceUsd: number } | null = null;
  private startingAccount: { mon: number; usdc: number; value: number } | null = null;
  private accountBusy = false;
  private predictionLabels: { block: number; mid: number; probability: number }[] = [];
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, kept: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** Call once the market params are known. Without it `trades` in the state is all zeros and no fills are ever seen. */
  attachTradeFeed(sizeDec: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, maker: this.market.address });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.head = block;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh(block).catch(() => {}); // fee estimate + margin + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.market.readBook();
      const readMs = performance.now() - t0;
      if (![book.bid, book.ask, book.mid].every(Number.isFinite) || book.bid <= 0 || book.ask <= book.bid) throw new Error("Invalid book");
      this.lastBook = book;
      if (config.strategyEnabled && this.market.wallet && !this.inflight.size && !this.accountBusy && (!this.account || block - this.account.block >= config.refreshBlocks)) {
        this.accountBusy = true;
        const known = [...this.orders].filter(([id]) => id > 0).map(([id, o]) => ({ id, side: o.side, price: o.price }));
        this.market.accountSnapshot(book.block, known).then(a => {
          if (!a) return;
          this.account = { ...a, mid: book.mid, inferenceUsd: this.totals.jevUsd };
          this.startingAccount ??= { mon: a.mon, usdc: a.usdc, value: a.mon * book.mid + a.usdc };
          appendFileSync("data/accounts.jsonl", JSON.stringify({ ...a, mid: book.mid }) + "\n");
        }).catch(() => {}).finally(() => { this.accountBusy = false; });
      }
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints (and our fills) since the last poll

      const observedPrints = this.observedPrints.splice(0);
      if (config.strategyEnabled) this.strategy.advance(block, book.mid, observedPrints, this.market.makerFeeBps);
      const state = this.buildState(block, book);
      const decision = await this.model.decide(state);
      if (config.strategyEnabled) {
        for (const result of this.markouts.advance(block, book.mid)) appendFileSync("data/markouts.jsonl", JSON.stringify(result) + "\n");
        for (const label of this.predictionLabels.filter(p => block >= p.block + config.horizonBlocks)) appendFileSync("data/calibration.jsonl", JSON.stringify({ ...label, observedBlock: block, up: book.mid > label.mid, brier: (label.probability - Number(book.mid > label.mid)) ** 2 }) + "\n");
        this.predictionLabels = this.predictionLabels.filter(p => block < p.block + config.horizonBlocks);
        if (!this.predictionLabels.length) this.predictionLabels.push({ block, mid: book.mid, probability: decision.probabilities.buy });
      }
      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      const other: Side = wanted === "buy" ? "sell" : "buy";
      // The position cap (and, live, margin funds) can only pick the reducing side. The probabilities still show the model's call.
      let side: Side | null = config.strategyEnabled ? (decision.action === "hold" ? null : wanted) : this.allowed(wanted, book) ? wanted : this.allowed(other, book) ? other : null;
      const vol = volatilityBps(this.mids);
      const minimum = this.market.minOrderMon ?? config.tradeSizeMon;
      const size = config.strategyEnabled ? Math.min(config.tradeSizeMon, Math.max(minimum, Math.floor((config.tradeSizeMon / (1 + vol / 10 + Math.abs(this.position.mon) / config.maxPositionMon)) / minimum) * minimum)) : config.tradeSizeMon;
      const touch = this.othersTouch(book);
      const distance = config.strategyEnabled ? Math.ceil(vol / 5 + Math.abs(this.position.mon) / config.maxPositionMon * 2) : 0;
      const rawPrice = this.market.quotePrice(wanted, touch) + (wanted === "buy" ? -1 : 1) * distance * this.market.tick;
      const price = Math.round(rawPrice / this.market.tick) * this.market.tick;
      const kept = (config.strategyEnabled || !config.quoteEveryBlock) ? this.keepable(wanted, touch, size, price) : null;

      this.gate = config.strategyEnabled ? this.strategy.evaluate({ block, book: touch, side: wanted, probability: decision.probabilities[wanted], price: kept?.price ?? price, size: kept?.size ?? size, gasUsd: kept ? 0 : this.market.estimatedGasUsd(book.mid, this.cancellable().length), inferenceUsd: this.model.name === "mock" ? 0 : decision.inputTokens / 1e6 * config.jevUsdPerMTok, pnlUsd: this.netPnl(book.mid), volatility: vol, allowed: size >= minimum && (kept ? Math.abs(this.position.mon + (wanted === "buy" ? kept.size : -kept.size)) <= config.maxPositionMon : this.allowed(wanted, book, size)) , fresh: this.head === block && book.block >= block - 1 && performance.now() - t0 < 300, keeping: !!kept }) : null;
      if (this.gate?.action === "skip") side = null;
      if (state.execution) state.execution.inferenceUsd = this.model.name === "mock" ? 0 : decision.inputTokens / 1e6 * config.jevUsdPerMTok;
      if (config.strategyEnabled && config.recordResearch) appendFileSync("data/research.jsonl", JSON.stringify({ version: 1, rulebook: RULEBOOK.version, block, book, prints: observedPrints, state, decision, gate: this.gate, makerFeeBps: this.market.makerFeeBps, minOrderMon: minimum, tick: this.market.tick, settings: this.strategy.settings }) + "\n");
      this.totals.decisions++;
      this.totals.jevUsd += this.model.name === "mock" ? 0 : (decision.inputTokens / 1e6) * config.jevUsdPerMTok;

      let quote: Quote | null = null;
      if (side) {
        decision.action = side;
        const keptOrder = config.strategyEnabled ? kept : config.quoteEveryBlock ? null : this.keepable(side, touch);
        if (keptOrder) {
          quote = { ...keptOrder, capped: side !== wanted };
          this.totals.kept++;
        } else {
          quote = config.strategyEnabled ? await this.market.send(block, side, size, touch, this.cancellable(), false, price) : await this.market.send(block, side, config.tradeSizeMon, touch, this.cancellable(), side !== wanted);
          this.totals.quotes++;
          if (quote.status === "sim") {
            this.orders.clear(); // the simulated cancel
            this.orders.set(--this.simId, { side, price: quote.price, size: quote.size, block, txHash: null, ...(config.strategyEnabled ? { queue: (side === "buy" ? touch.levels.bids : touch.levels.asks).filter(([p]) => side === "buy" ? p >= quote!.price : p <= quote!.price).reduce((a, [, size]) => a + size, 0) } : {}) });
          } else if (quote.txHash) {
            this.inflight.set(quote.txHash, quote);
          }
        }
      }
      if (config.strategyEnabled && !side) {
        decision.action = "hold";
        const cancel = this.cancellable();
        if (cancel.length) {
          quote = await this.market.send(block, wanted, 0, touch, cancel, false);
          if (quote.txHash) this.inflight.set(quote.txHash, quote);
          this.totals.quotes++;
        }
        if (!this.market.wallet) this.orders.clear();
      }
      this.emit(block, book, decision, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
      // A failed book read or model call must not leave known exposure quoting indefinitely.
      if (config.strategyEnabled && this.lastBook) {
        try {
          const ids = this.cancellable();
          if (ids.length) {
            const q = await this.market.send(block, "buy", 0, this.lastBook, ids, false);
            this.totals.quotes++;
            if (q.txHash) this.inflight.set(q.txHash, q);
            this.onQuote(block, q);
          }
          if (!this.market.wallet) this.orders.clear();
        } catch (cancelError) { console.error("Risk cancellation failed:", (cancelError as Error).message); }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * The resting orders this block's update cancels: every one we know of, except those an unconfirmed
   * update ahead of it already cancels. Kuru reverts a cancel of an order that is gone, and that takes
   * the whole update with it. Simulated orders (negative ids) are never sent.
   */
  private cancellable() {
    const taken = new Set([...this.inflight.values()].flatMap((q) => q.cancel));
    return [...this.orders.keys()].filter((id) => id > 0 && !taken.has(id));
  }

  /**
   * The book with our own orders taken out of the touch. The book includes them, so quoting "one tick
   * inside the touch" against it would step inside our own order every block, walking our price across
   * the spread. Only the best bid/ask change; the rest of the book is as read.
   */
  private othersTouch(book: Book): Book {
    const ours = new Map<string, number>();
    const add = (side: Side, price: number, size: number) => ours.set(`${side}:${price.toFixed(9)}`, (ours.get(`${side}:${price.toFixed(9)}`) ?? 0) + size);
    for (const [id, o] of this.orders) if (id > 0) add(o.side, o.price, o.size); // simulated orders are not on the book
    for (const q of this.inflight.values()) add(q.side, q.price, q.size);
    if (!ours.size) return book;
    const best = (levels: [number, number][], side: Side, fallback: number) =>
      levels.find(([p, s]) => s - (ours.get(`${side}:${p.toFixed(9)}`) ?? 0) > 1e-9)?.[0] ?? fallback;
    const bid = best(book.levels.bids, "buy", book.bid), ask = best(book.levels.asks, "sell", book.ask);
    return { ...book, bid, ask, mid: (bid + ask) / 2, spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 10_000 };
  }

  /**
   * The order to keep this block instead of sending a new one: our only order (resting or unconfirmed),
   * on `side`, unfilled, not crossing the other side, and within `requoteTicks` of where a new order
   * would go (either way: a little behind the touch fills less, but costs no gas). Null: replace it.
   */
  private keepable(side: Side, touch: Book, size = config.tradeSizeMon, price = this.market.quotePrice(side, touch)): Quote | null {
    const resting = [...this.orders.entries()], flying = [...this.inflight.values()];
    if (resting.length + flying.length !== 1) return null;
    const o = flying[0] ?? { ...resting[0]![1], orderId: resting[0]![0] };
    const orderId = "orderId" in o ? (o.orderId ?? null) : null;
    if (o.side !== side || Math.abs(o.size - size) > 1e-9 || (config.strategyEnabled && this.head - (resting[0]?.[1].block ?? this.head) >= config.horizonBlocks)) return null;
    const exposure = this.position.mon + (side === "buy" ? o.size : -o.size);
    if (Math.abs(exposure) > config.maxPositionMon) return null;
    const off = Math.round(Math.abs(o.price - price) / this.market.tick);
    const crosses = side === "buy" ? o.price >= touch.ask : o.price <= touch.bid;
    if (crosses || off > config.requoteTicks) return null;
    return { side, price: o.price, size: o.size, txHash: o.txHash, gasMon: 0, cancel: [], status: "resting", orderId: orderId !== null && orderId > 0 ? orderId : null, capped: false };
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled, minedBlock }: QuoteResult) {
    if (quote.txHash) this.inflight.delete(quote.txHash);
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    for (const id of canceled) {
      const o = this.orders.get(id);
      if (o) this.market.moveMargin(minedBlock, o.side === "sell" ? o.size : 0, o.side === "buy" ? o.size * o.price : 0); // what was left comes back
      this.orders.delete(id);
    }
    if (quote.status === "placed" && quote.orderId !== null) {
      this.market.moveMargin(minedBlock, quote.side === "sell" ? -quote.size : 0, quote.side === "buy" ? -quote.size * quote.price : 0);
      // Its fills may have been read before this receipt: then the order rests with what they left, or not at all.
      const left = this.earlyFills.get(quote.orderId) ?? quote.size;
      this.earlyFills.delete(quote.orderId);
      if (left > 0) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: left, block, txHash: quote.txHash });
    }
    if (quote.status === "reverted") {
      this.totals.reverted++;
      this.recheck(quote.cancel);
    }
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    this.onQuote(block, quote);
  }

  /**
   * A revert means one of its cancels was already gone or the margin could not fund the order. Both
   * would repeat every block, so check those orders and the margin against the chain (off the hot path).
   */
  private recheck(ids: number[]) {
    this.market.refreshMargin(this.head).catch(() => {});
    const known = ids.filter((id) => this.orders.has(id));
    if (!known.length) return;
    this.market.orderSizes(known).then((sizes) => {
      for (const [id, size] of sizes) {
        const o = this.orders.get(id);
        if (!o) continue;
        if (size > 0) o.size = size;
        else this.orders.delete(id);
      }
    }).catch(() => {});
  }

  /** After each trade-log poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    if (config.strategyEnabled) this.observedPrints.push(...prints);
    const fills: (Fill & { block: number })[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      if (config.strategyEnabled) this.markouts.add(f.block, f);
      this.applyFill(f);
      const { block, ...fill } = f;
      byBlock.set(block, [...(byBlock.get(block) ?? []), fill]);
    }
    const oldest = this.history[0]?.block ?? 0;
    for (const [block, fs] of byBlock) {
      const e = this.history.find((h) => h.block === block);
      if (!e && block >= oldest) { this.pendingFills.set(block, [...(this.pendingFills.get(block) ?? []), ...fs]); continue; } // its event is not out yet: goes out with it
      const fill = aggregate(e?.fill ? [e.fill, ...fs] : fs);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (!o) this.rememberEarlyFill(f.orderId, f.updatedSize); // its receipt has not come in yet
      else if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else o.size = f.updatedSize;
      this.market.moveMargin(f.block, f.side === "buy" ? f.size : this.market.makerFeeBps ? -f.size * this.market.makerFeeBps / 1e4 : 0, f.side === "sell" ? f.size * f.price : this.market.makerFeeBps ? -f.size * f.price * this.market.makerFeeBps / 1e4 : 0); // a fill credits the other asset
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  private rememberEarlyFill(orderId: number, left: number) {
    this.earlyFills.delete(orderId); // re-insert so the newest is last
    this.earlyFills.set(orderId, left);
    if (this.earlyFills.size > EARLY_FILLS_KEPT) this.earlyFills.delete(this.earlyFills.keys().next().value!);
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const hit = o.side === "buy" ? p.side === "sell" && p.price <= o.price : p.side === "buy" && p.price >= o.price;
        if (!hit) continue;
        const ahead = Math.min(o.queue ?? 0, p.size);
        o.queue = (o.queue ?? 0) - ahead;
        const size = Math.min(o.size, p.size - ahead);
        if (size <= 0) continue;
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block: p.block });
      }
    }
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /**
   * Would one order of ours on this side keep us inside the cap and (live) inside margin funds? An update
   * cancels every order we know of, so only unconfirmed ones (whose ids we do not have yet) can rest beside it.
   */
  private allowed(side: Side, book: Book, size = config.tradeSizeMon) {
    // Keeping the one existing order adds neither exposure nor a new margin reservation.
    if (!config.strategyEnabled && !config.quoteEveryBlock && this.keepable(side, this.othersTouch(book))) return true;
    const unconfirmed = (s: Side) => [...this.inflight.values()].filter((q) => q.side === s).reduce((a, q) => a + q.size, 0);
    const exposure = side === "buy" ? this.position.mon + unconfirmed("buy") + size : this.position.mon - unconfirmed("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    return side === "buy" ? this.fundable("buy") >= size * book.ask : this.fundable("sell") >= size;
  }

  /**
   * Margin this block's update can spend on `side` (USDC for a bid, MON for an ask): what is free, plus
   * what our resting orders on that side give back when they are cancelled (Kuru runs a batchUpdate's
   * cancels before its places), minus what our unconfirmed orders will lock before this one lands.
   */
  private fundable(side: Side) {
    const value = (o: { side: Side; size: number; price: number }) => (o.side !== side ? 0 : side === "buy" ? o.size * o.price : o.size);
    let funds = side === "buy" ? this.market.margin.usdc : this.market.margin.mon;
    for (const o of this.orders.values()) funds += value(o);
    for (const q of this.inflight.values()) funds -= value(q);
    return funds;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: "MON-USDC",
      block,
      horizonBlocks: H,
      blockMs: 300,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      ...(config.strategyEnabled ? {
        portfolio: { inventoryMon: this.position.mon, entryPrice: this.entryPrice(), pendingBuyMon: this.restingMon("buy"), pendingSellMon: this.restingMon("sell"), freeMon: this.market.margin.mon, freeUsdc: this.market.margin.usdc, netPnlUsd: this.netPnl(book.mid), maxPositionMon: config.maxPositionMon },
        execution: { volatilityBps: volatilityBps(this.mids), makerFeeBps: this.market.makerFeeBps, exitCostBps: config.exitCostBps, gasUsd: this.market.estimatedGasUsd(book.mid), quoteAgeBlocks: this.orders.size ? block - Math.min(...[...this.orders.values()].map(o => o.block)) : 0, rulebook: RULEBOOK.version },
      } : {}),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    this.feesUsd += f.size * f.price * (this.market.makerFeeBps ?? 0) / 1e4;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.fills++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private netPnl(mid: number) { return this.totals.realizedUsd + this.unrealizedUsd(mid) - this.totals.gasMon * mid - this.totals.jevUsd - this.feesUsd; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    // Fills from this block (or an earlier one that never got an event) that were read before it went out.
    const due = [...this.pendingFills].filter(([b]) => b <= block);
    for (const [b] of due) this.pendingFills.delete(b);
    const fill = due.length ? aggregate(due.flatMap(([, fs]) => fs)) : null;
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = this.netPnl(book.mid);
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      ...(config.strategyEnabled ? { account: this.account && this.startingAccount ? { ...this.account, equityUsd: this.account.mon * this.account.mid + this.account.usdc - this.account.inferenceUsd, pnlUsd: this.account.mon * this.account.mid + this.account.usdc - this.account.inferenceUsd - this.startingAccount.value, vsHoldUsd: (this.account.mon - this.startingAccount.mon) * this.account.mid + this.account.usdc - this.startingAccount.usdc - this.account.inferenceUsd } : null } : {}),
      ...(config.strategyEnabled ? { strategy: this.gate } : {}),
      fill,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, ...(config.strategyEnabled ? { tradingFeesUsd: round(this.feesUsd, 6) } : {}), jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    appendFileSync("data/events.jsonl", JSON.stringify(event) + "\n");
    this.onEvent(event, timing);
    if (fill) this.onFill(block, fill);
  }
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
