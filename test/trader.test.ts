import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ethers } from "ethers";
import { config } from "../src/config";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "../src/market";
import type { Decision, Model, TradeState } from "../src/model";
import { TradeFeed, type MakerFill, type TradePrint } from "../src/trades";
import { Trader, type BlockEvent, type Timing } from "../src/trader";
import { startPracticeExchange, type PracticeExchange } from "../scripts/practice-exchange";
import { flush, inTempDir, isolateConfig, until } from "./helpers";

isolateConfig();
inTempDir();
const errors = spyOn(console, "error").mockImplementation(() => {});
afterAll(() => errors.mockRestore());
afterEach(() => errors.mockClear());

const ME = "0x9D65359C49273ca91FDabABFb53d367F58e53Fef";
const TICK = 1e-6;

function mkBook(bid: number, ask: number, extra: Partial<Book> = {}): Book {
  return {
    block: 1, bid, ask, mid: (bid + ask) / 2, spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 1e4, imbalance: 0.25,
    levels: { bids: [[bid, 2299.04], [bid - TICK, 10]], asks: [[ask, 819], [ask + TICK, 5.55]] },
    depthBps: { "10": { bid: 1000.04, ask: 900 }, "25": { bid: 3000, ask: 2500 }, "50": { bid: 6000, ask: 5000.06 } },
    ...extra,
  };
}

/** Stand-in for Market: records sends, answers pollPending from a queue. */
function fakeMarket(live: boolean) {
  let n = 0;
  const m = {
    wallet: live ? ({} as ethers.Wallet) : null,
    address: live ? ME : null,
    margin: { mon: 1e9, usdc: 1e9 },
    book: mkBook(0.0236, 0.023606),
    results: [] as QuoteResult[],
    /** Margin moves booked by the trader: [block, mon, usdc]. */
    moves: [] as [number | null, number, number][],
    /** What s_orders says per order id (missing: gone). */
    chainSizes: new Map<number, number>(),
    tick: TICK,
    quotePrice: (side: Side, book: Book) => (side === "buy" ? book.bid + TICK : book.ask - TICK),
    readBook: mock(async () => m.book),
    send: mock(async (block: number, side: Side, size: number, book: Book, cancel: number[], capped: boolean): Promise<Quote> => ({
      side, price: side === "buy" ? book.bid + TICK : book.ask - TICK, size, txHash: live ? `0xtx${++n}` : null,
      gasMon: live ? 0.04 : 0, cancel, status: live ? "sent" : "sim", orderId: null, capped,
    })),
    pollPending: mock(async (_block: number) => m.results.splice(0)),
    refresh: mock(async (_block?: number) => {}),
    refreshMargin: mock(async (_block?: number) => {}),
    moveMargin: mock((block: number | null, mon: number, usdc: number) => { m.moves.push([block, mon, usdc]); m.margin.mon += mon; m.margin.usdc += usdc; }),
    orderSizes: mock(async (ids: number[]) => new Map(ids.map((id) => [id, m.chainSizes.get(id) ?? 0]))),
  };
  return m;
}
type FakeMarket = ReturnType<typeof fakeMarket>;

function fakeModel(pick: (s: TradeState) => Partial<Decision> = () => ({})) {
  const states: TradeState[] = [];
  const model = {
    name: "fake", states,
    decide: mock(async (s: TradeState): Promise<Decision> => {
      states.push(s);
      return { action: "buy", probabilities: { buy: 0.7, sell: 0.3, hold: 0 }, upIn10: 0.7, latencyMs: 12.4, inputTokens: 1000, ...pick(s) };
    }),
  };
  return model;
}

/** Stand-in for TradeFeed: whatever the test queues comes out of the next poll. */
class FakeFeed {
  prints: TradePrint[] = [];
  fills: MakerFill[] = [];
  polled: number[] = [];
  summaryValue = { count: 2, buyMon: 300, sellMon: 100, cvdMon: 200, vwap: 0.0236, lastPrice: 0.02361, lastSide: "buy" as const };
  recentValue: TradePrint[] = [{ block: 9, side: "sell", size: 200.04, price: 0.0235991 }];
  async poll(b: number) { this.polled.push(b); }
  drainPrints() { const o = this.prints; this.prints = []; return o; }
  drainFills() { const o = this.fills; this.fills = []; return o; }
  summary(_h: number, _b: number) { return this.summaryValue; }
  recent(_n: number) { return this.recentValue; }
}

function setup(live = false, pick?: (s: TradeState) => Partial<Decision>) {
  const market = fakeMarket(live), model = fakeModel(pick), feed = new FakeFeed();
  const events: BlockEvent[] = [], timings: (Timing | undefined)[] = [], fills: [number, Fill][] = [], quotes: [number, Quote][] = [];
  const trader = new Trader(market as unknown as Market, model as unknown as Model, (e, t) => { events.push(structuredClone(e)); timings.push(t); }, (b, f) => fills.push([b, f]), (b, q) => quotes.push([b, q]));
  (trader as any).trades = feed;
  const block = async (b: number) => { await trader.onBlock(b); await flush(); };
  return { market, model, feed, trader, events, timings, fills, quotes, block };
}

beforeEach(() => {
  config.tradeSizeMon = 200; config.maxPositionMon = 1000; config.bankrollUsd = 100; config.horizonBlocks = 100;
  config.refreshBlocks = 200; config.historySize = 1000;
  config.quoteEveryBlock = true; config.requoteTicks = 5; // most tests here are about the update itself; keeping has its own describe
});

// ------------------------------------------------------------------------------------------------

describe("one block", () => {
  test("reads the book, asks the model, posts one order on its side, and emits the block", async () => {
    const t = setup(false);
    await t.block(100);
    expect(t.market.readBook).toHaveBeenCalledTimes(1);
    expect(t.model.decide).toHaveBeenCalledTimes(1);
    expect(t.market.send).toHaveBeenCalledWith(100, "buy", 200, t.market.book, [], false);
    const e = t.events[0]!;
    expect(e).toMatchObject({
      block: 100, mid: 0.023603, bestBid: 0.0236, bestAsk: 0.023606, spreadBps: Math.round(t.market.book.spreadBps * 100) / 100,
      decision: { action: "buy", probabilities: { buy: 0.7, sell: 0.3, hold: 0 }, upIn10: 0.7, latencyMs: 12, late: false },
      quote: { side: "buy", price: 0.0236 + TICK, size: 200, status: "sim", capped: false },
      fill: null,
      resting: { bidMon: 200, askMon: 0 },
      position: { side: "flat", size: 0, entryPrice: null, unrealizedUsd: 0, unrealizedMon: 0 },
      totals: { blocks: 1, decisions: 1, quotes: 1, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0.000042, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: -0, pnlMon: -0.0018, pnlPct: -0 },
    });
    expect(Math.abs(e.ts - Date.now())).toBeLessThan(5000);
    expect(Number.isInteger(t.timings[0]!.readMs) && Number.isInteger(t.timings[0]!.loopMs)).toBe(true);
    expect(t.trader.history).toEqual([e]);
    expect(t.feed.polled).toEqual([100]);
    expect(t.market.pollPending).toHaveBeenCalledWith(100);
  });

  test("a sell decision posts an ask", async () => {
    const t = setup(false, () => ({ action: "sell", probabilities: { buy: 0.2, sell: 0.8, hold: 0 }, upIn10: 0.2 }));
    await t.block(1);
    expect(t.events[0]!.quote).toMatchObject({ side: "sell", price: 0.023606 - TICK });
    expect(t.events[0]!.resting).toEqual({ bidMon: 0, askMon: 200 });
  });

  test("appends every event to data/events.jsonl", async () => {
    const t = setup(false);
    await t.block(1);
    await t.block(2);
    const lines = readFileSync("data/events.jsonl", "utf8").trim().split("\n").slice(-2).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.block)).toEqual([1, 2]);
    expect(existsSync("data")).toBe(true);
  });

  test("history keeps the newest HISTORY_SIZE events", async () => {
    config.historySize = 3;
    const t = setup(false);
    for (let b = 1; b <= 5; b++) await t.block(b);
    expect(t.trader.history.map((e) => e.block)).toEqual([3, 4, 5]);
  });

  test("Jev spend accumulates per input token at $0.042 per million", async () => {
    const t = setup(false, () => ({ inputTokens: 2_500_000 }));
    await t.block(1);
    await t.block(2);
    expect(t.events[1]!.totals.jevUsd).toBe(0.21);
  });
});

describe("timing", () => {
  test("a block that arrives while the last is still deciding is emitted late: hold, no order", async () => {
    const t = setup(false);
    await t.block(1); // gives the trader a last book
    let release!: () => void;
    t.model.decide.mockImplementationOnce(async (s: TradeState) => { await new Promise<void>((r) => (release = r)); return { action: "sell", probabilities: { buy: 0.1, sell: 0.9, hold: 0 }, upIn10: 0.1, latencyMs: 400, inputTokens: 1 }; });
    const slow = t.trader.onBlock(2);
    await flush();
    await t.block(3);
    expect(t.events.at(-1)).toMatchObject({ block: 3, decision: { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }, quote: null });
    expect(t.events.at(-1)!.totals).toMatchObject({ blocks: 3, decisions: 1, lateBlocks: 1 });
    expect(t.timings.at(-1)).toBeUndefined();
    release();
    await slow;
    expect(t.events.at(-1)!.block).toBe(2);
    expect(t.events.at(-1)!.totals).toMatchObject({ blocks: 3, decisions: 2, lateBlocks: 1 });
    await t.block(4); // not busy any more
    expect(t.events.at(-1)!.decision!.late).toBe(false);
  });

  test("a late block before any book has been read is counted but not emitted", async () => {
    const t = setup(false);
    let release!: () => void;
    t.market.readBook.mockImplementationOnce(async () => { await new Promise<void>((r) => (release = r)); return t.market.book; });
    const first = t.trader.onBlock(1);
    await t.block(2);
    expect(t.events).toEqual([]);
    release();
    await first;
    expect(t.events[0]!.totals).toMatchObject({ blocks: 2, lateBlocks: 1 });
  });

  test("a failed book read or model call logs, emits nothing for that block, and frees the loop", async () => {
    const t = setup(false);
    t.market.readBook.mockImplementationOnce(async () => { throw new Error("empty book side at block 7 (bids=0 asks=7)"); });
    await t.block(7);
    expect(errors).toHaveBeenCalledWith("block 7:", "empty book side at block 7 (bids=0 asks=7)");
    t.model.decide.mockImplementationOnce(async () => { throw new Error("overloaded"); });
    await t.block(8);
    expect(errors).toHaveBeenCalledWith("block 8:", "overloaded");
    expect(t.events).toEqual([]);
    await t.block(9);
    expect(t.events.map((e) => e.block)).toEqual([9]);
    expect(t.events[0]!.totals).toMatchObject({ blocks: 3, decisions: 1, quotes: 1 });
  });

  test("refreshes fee, margin and vault every REFRESH_BLOCKS; a failed refresh is ignored", async () => {
    config.refreshBlocks = 3;
    const t = setup(false);
    t.market.refresh.mockImplementation(async () => { throw new Error("down"); });
    for (let b = 1; b <= 7; b++) await t.block(b);
    expect(t.market.refresh.mock.calls).toEqual([[3], [6]]); // blocks 3 and 6, with the head
  });

  test("a failing receipt poll is ignored", async () => {
    const t = setup(true);
    t.market.pollPending.mockImplementationOnce(async () => { throw new Error("boom"); });
    await t.block(1);
    expect(t.events.length).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------

describe("what the model sees", () => {
  test("the TradeState: book, depth, returns over the horizon, sampled mids, taker flow, allowed sides", async () => {
    config.horizonBlocks = 20;
    const t = setup(false);
    const mids: number[] = [];
    for (let b = 1; b <= 30; b++) {
      const bid = 0.0236 + b * TICK;
      t.market.book = mkBook(bid, bid + 4 * TICK);
      mids.push(t.market.book.mid);
      await t.block(b);
    }
    const s = t.model.states.at(-1)!;
    const n = mids.length, ret = (k: number) => Math.round(((mids[n - 1]! - mids[n - 1 - k]!) / mids[n - 1 - k]!) * 1e4 * 100) / 100;
    expect(s).toEqual({
      market: "MON-USDC", block: 30, horizonBlocks: 20, blockMs: 300, mid: mids.at(-1)!,
      spreadBps: Math.round(t.market.book.spreadBps * 100) / 100, bookImbalance: 0.25,
      depth: { "10bps": { bid: 1000, ask: 900 }, "25bps": { bid: 3000, ask: 2500 }, "50bps": { bid: 6000, ask: 5000.1 } },
      book: { bids: ["0.023630 x 2299", "0.023629 x 10"], asks: ["0.023634 x 819", "0.023635 x 5.6"] },
      returnsBps: { last1: ret(1), last5: ret(5), last20: ret(20), last100: 0 }, // fewer than 101 mids: 0
      recentMids: [mids[14], mids[19], mids[24], mids[29]].map((x) => x!.toFixed(6)).join(" "), // every 5th of the last 20, newest included
      trades: t.feed.summaryValue,
      recentTrades: ["9 sell 200 @ 0.023599"],
      allowed: { buy: true, sell: true },
    });
  });

  test("before the trade feed is attached: zero taker flow and no prints", async () => {
    const t = setup(false);
    (t.trader as any).trades = null;
    await t.trader.onBlock(1);
    expect(t.model.states[0]!.trades).toEqual({ count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null });
    expect(t.model.states[0]!.recentTrades).toEqual([]);
  });

  test("keeps the last 400 mids", async () => {
    const t = setup(false);
    for (let b = 1; b <= 410; b++) await t.trader.onBlock(b);
    expect((t.trader as any).mids.length).toBe(400);
  });

  test("attachTradeFeed watches this market on the read RPC, with our wallet as the maker", () => {
    const t = setup(true);
    config.readRpcUrl = "http://read.example";
    t.trader.attachTradeFeed(10);
    const f = (t.trader as any).trades as TradeFeed;
    expect(f).toBeInstanceOf(TradeFeed);
    expect((f as any).url).toBe("http://read.example");
    expect((f as any).market).toBe(config.market);
    expect((f as any).maker).toBe(ME.toLowerCase());
    expect((f as any).sizeDec).toBe(10);
  });
});

// ------------------------------------------------------------------------------------------------

describe("listeners", () => {
  test("fill and quote listeners are optional", async () => {
    const market = fakeMarket(true), model = fakeModel(), feed = new FakeFeed();
    const events: BlockEvent[] = [];
    const trader = new Trader(market as unknown as Market, model as unknown as Model, (e) => events.push(e));
    (trader as any).trades = feed;
    await trader.onBlock(1);
    market.results.push({ block: 1, quote: { ...events[0]!.quote!, status: "placed", orderId: 3, gasMon: 0.01 }, canceled: [], minedBlock: null });
    feed.fills.push({ block: 1, txHash: "0xt", orderId: 3, price: 0.0236, size: 200, updatedSize: 0, side: "buy" });
    await trader.onBlock(2);
    await flush();
    expect(trader.history[0]!.quote!.status).toBe("placed");
    expect(trader.history[0]!.fill).toMatchObject({ size: 200 });
  });
});

describe("position cap and margin", () => {
  test("live: unconfirmed orders count toward the cap; at the cap the order goes on the other side, marked capped", async () => {
    const t = setup(true);
    for (let b = 1; b <= 6; b++) await t.block(b); // the model always says buy; no receipts come back
    expect(t.events.map((e) => e.quote!.side)).toEqual(["buy", "buy", "buy", "buy", "buy", "sell"]);
    expect(t.events[5]!.quote!.capped).toBe(true);
    expect(t.events[5]!.decision!.action).toBe("sell"); // the order's side...
    expect(t.events[5]!.decision!.probabilities.buy).toBe(0.7); // ...but the model's call is still visible
    expect(t.events[5]!.resting).toEqual({ bidMon: 1000, askMon: 200 });
    expect(t.model.states[5]!.allowed).toEqual({ buy: false, sell: true });
  });

  test("live: margin decides too (USDC for bids at the ask, MON for asks); neither side fundable means no order", async () => {
    const t = setup(true);
    t.market.margin = { mon: 0, usdc: 200 * 0.023606 - 1e-9 };
    await t.block(1);
    expect(t.events[0]!.quote).toBeNull();
    expect(t.events[0]!.decision!.action).toBe("buy"); // unchanged: no order placed
    expect(t.events[0]!.totals).toMatchObject({ decisions: 1, quotes: 0 });
    expect(t.market.send).not.toHaveBeenCalled();
    t.market.margin = { mon: 200, usdc: 0 };
    await t.block(2);
    expect(t.events[1]!.quote).toMatchObject({ side: "sell", capped: true });
    t.market.margin = { mon: 0, usdc: 200 * 0.023606 };
    await t.block(3);
    expect(t.events[2]!.quote).toMatchObject({ side: "buy", capped: false });
  });

  test("dry run ignores margin, and replaces its one simulated order every block", async () => {
    const t = setup(false);
    t.market.margin = { mon: 0, usdc: 0 };
    for (let b = 1; b <= 8; b++) await t.block(b);
    expect(t.events.every((e) => e.quote?.side === "buy" && !e.quote.capped)).toBe(true);
    expect(t.events.at(-1)!.resting).toEqual({ bidMon: 200, askMon: 0 });
    expect(t.market.send.mock.calls.every((c) => (c[4] as number[]).length === 0)).toBe(true); // simulated ids are never sent as cancels
  });

  test("orders this update cancels do not count toward the cap", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 501, gasMon: 0 }, canceled: [], minedBlock: 2 });
    (t.trader as any).position = { mon: 800, costUsd: 800 * 0.0236 };
    await t.block(2); // long 800 + a replaced 200 bid = 1000: within the cap (the old bid goes)
    expect(t.events[1]!.quote).toMatchObject({ side: "buy", capped: false, cancel: [501] });
  });

  test("the cap counts the position too", async () => {
    const t = setup(false);
    (t.trader as any).position = { mon: 900, costUsd: 900 * 0.0236 };
    await t.block(1);
    expect(t.events[0]!.quote).toMatchObject({ side: "sell", capped: true });
    (t.trader as any).position = { mon: -900, costUsd: -900 * 0.0236 };
    (t.trader as any).orders.clear();
    t.model.decide.mockImplementationOnce(async () => ({ action: "sell", probabilities: { buy: 0.1, sell: 0.9, hold: 0 }, upIn10: 0.1, latencyMs: 1, inputTokens: 1 }));
    await t.block(2);
    expect(t.events[1]!.quote).toMatchObject({ side: "buy", capped: true });
  });
});

// ------------------------------------------------------------------------------------------------

describe("receipts (live)", () => {
  test("placed: becomes a resting order that the next block cancels; gas is booked; the event and listeners get the update", async () => {
    const t = setup(true);
    await t.block(1);
    const q1 = t.events[0]!.quote!;
    t.market.results.push({ block: 1, quote: { ...q1, status: "placed", orderId: 501, gasMon: 0.0436 }, canceled: [], minedBlock: null });
    await t.block(2); // receipt applied at the start of block 2, before its order is built
    expect(t.market.send.mock.calls[1]![4]).toEqual([501]);
    expect(t.quotes).toEqual([[1, { ...q1, status: "placed", orderId: 501, gasMon: 0.0436 }]]);
    expect(t.trader.history[0]!.quote).toMatchObject({ status: "placed", orderId: 501 });
    expect(t.events[1]!.totals.gasMon).toBe(0.0436);
    expect(t.events[1]!.totals.gasUsd).toBeCloseTo(0.0436 * 0.023603, 6);
    expect(t.events[1]!.totals.pnlUsd).toBe(Math.round((-0.0436 * 0.023603 - t.events[1]!.totals.jevUsd) * 1e4) / 1e4);
    expect(t.events[1]!.resting).toEqual({ bidMon: 400, askMon: 0 }); // 501 resting + block 2's unconfirmed bid
    const q2 = t.events[1]!.quote!;
    t.market.results.push({ block: 2, quote: { ...q2, status: "placed", orderId: 502, gasMon: 0.0436 }, canceled: [501], minedBlock: null });
    await t.block(3);
    expect(t.market.send.mock.calls[2]![4]).toEqual([502]);
  });

  test("reverted and lost: counted, gas booked for reverts, nothing resting", async () => {
    const t = setup(true);
    await t.block(1);
    await t.block(2);
    const [q1, q2] = [t.events[0]!.quote!, t.events[1]!.quote!];
    t.market.results.push({ block: 1, quote: { ...q1, status: "reverted", gasMon: 0.0436 }, canceled: [], minedBlock: null }, { block: 2, quote: { ...q2, status: "lost", gasMon: 0 }, canceled: [], minedBlock: null });
    await t.block(3);
    expect(t.events[2]!.totals).toMatchObject({ reverted: 1, gasMon: 0.0436 });
    expect(t.events[2]!.resting).toEqual({ bidMon: 200, askMon: 0 }); // only block 3's own
    expect(t.market.send.mock.calls[2]![4]).toEqual([]);
  });

  test("a receipt for a block no longer in history still reaches the listener", async () => {
    config.historySize = 1;
    const t = setup(true);
    await t.block(1);
    await t.block(2);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 9, gasMon: 0.01 }, canceled: [], minedBlock: null });
    await t.block(3);
    expect(t.quotes.map((q) => q[0])).toEqual([1]);
  });
});

describe("keeping the resting order (QUOTE_EVERY_BLOCK off)", () => {
  beforeEach(() => { config.quoteEveryBlock = false; });
  const placed = (t: ReturnType<typeof setup>, i: number, orderId: number, canceled: number[] = []) =>
    t.market.results.push({ block: t.events[i]!.block, quote: { ...t.events[i]!.quote!, status: "placed", orderId, gasMon: 0.03 }, canceled, minedBlock: t.events[i]!.block + 1 });

  test("same side, touch unchanged: nothing is sent, the block shows the order already resting", async () => {
    const t = setup(true);
    await t.block(1); // sends
    await t.block(2); // unconfirmed but fine: keep it
    placed(t, 0, 501);
    await t.block(3); // confirmed and still fine: keep it
    expect(t.market.send).toHaveBeenCalledTimes(1);
    const q1 = t.events[0]!.quote!;
    expect(t.events[1]!.quote).toEqual({ side: "buy", price: q1.price, size: 200, txHash: q1.txHash, gasMon: 0, cancel: [], status: "resting", orderId: null, capped: false });
    expect(t.events[2]!.quote).toMatchObject({ status: "resting", orderId: 501, txHash: q1.txHash, gasMon: 0 });
    expect(t.events[2]!.totals).toMatchObject({ decisions: 3, quotes: 1, kept: 2 });
    expect(t.events[2]!.resting).toEqual({ bidMon: 200, askMon: 0 });
  });

  test("the model turns to the other side: cancel and replace", async () => {
    let side: Side = "buy";
    const t = setup(true, () => ({ action: side }));
    await t.block(1);
    placed(t, 0, 501);
    side = "sell";
    await t.block(2);
    expect(t.market.send).toHaveBeenCalledTimes(2);
    expect(t.events[1]!.quote).toMatchObject({ side: "sell", status: "sent", cancel: [501] });
  });

  test("keeping an unconfirmed order at the position cap does not reserve a second order", async () => {
    config.maxPositionMon = 200;
    const t = setup(true);
    await t.block(1);
    await t.block(2);
    expect(t.market.send).toHaveBeenCalledTimes(1);
    expect(t.events[1]!.quote).toMatchObject({ side: "buy", status: "resting", capped: false });
    expect(t.model.states[1]!.allowed.buy).toBe(true);
  });

  test("keeping an unconfirmed order needs no funds beyond those already reserved for it", async () => {
    const t = setup(true);
    t.market.margin = { mon: 0, usdc: config.tradeSizeMon * t.market.book.ask };
    await t.block(1);
    await t.block(2);
    expect(t.market.send).toHaveBeenCalledTimes(1);
    expect(t.events[1]!.quote).toMatchObject({ side: "buy", status: "resting", gasMon: 0 });
    expect(t.model.states[1]!.allowed.buy).toBe(true);
  });

  test("an existing order is not kept if its exposure exceeds the position cap", async () => {
    const t = setup(true);
    await t.block(1);
    config.maxPositionMon = 100;
    await t.block(2);
    expect(t.events[1]!.quote).toBeNull();
    expect(t.events[1]!.totals.kept).toBe(0);
  });

  test("within REQUOTE_TICKS of where a new order would go (ahead or behind) it stays; further, it moves", async () => {
    const t = setup(true);
    await t.block(1); // bid at 0.023601
    placed(t, 0, 501);
    t.market.book = mkBook(0.0236 + 3 * TICK, 0.023606 + 3 * TICK); // the touch moved up 3 ticks: we are behind, by 3
    await t.block(2);
    t.market.book = mkBook(0.0236 - 5 * TICK, 0.023606); // down 5: a new bid would go 5 below ours
    await t.block(3);
    expect(t.market.send).toHaveBeenCalledTimes(1);
    t.market.book = mkBook(0.0236 + 6 * TICK, 0.023606 + 6 * TICK); // 6 behind: too far
    await t.block(4);
    expect(t.market.send).toHaveBeenCalledTimes(2);
    expect(t.events[3]!.quote).toMatchObject({ status: "sent", price: 0.0236 + 7 * TICK, cancel: [501] });
  });

  test("never keeps an order the other side has reached", async () => {
    config.requoteTicks = 50;
    const t = setup(true);
    await t.block(1); // bid at 0.023601
    placed(t, 0, 501);
    t.market.book = mkBook(0.02359, 0.023601); // the best ask is now at our bid
    await t.block(2);
    expect(t.market.send).toHaveBeenCalledTimes(2);
  });

  test("a partly filled order is replaced to quote the full size again", async () => {
    const t = setup(true);
    await t.block(1);
    placed(t, 0, 501);
    await t.block(2); // kept
    t.feed.fills.push({ block: 2, txHash: "0xt", orderId: 501, price: 0.023601, size: 120, updatedSize: 80, side: "buy" });
    (t.trader as any).harvest();
    await t.block(3);
    expect(t.market.send).toHaveBeenCalledTimes(2);
    expect(t.events[2]!.quote).toMatchObject({ status: "sent", size: 200, cancel: [501] });
  });

  test("more than one order of ours out there (an unconfirmed replace): no keeping, the next update cleans up", async () => {
    let side: Side = "buy";
    const t = setup(true, () => ({ action: side }));
    await t.block(1);
    placed(t, 0, 501);
    side = "sell";
    await t.block(2); // replace sent; 501 still known until its cancel is confirmed
    side = "buy";
    await t.block(3);
    expect(t.market.send).toHaveBeenCalledTimes(3);
  });

  test("dry run: the simulated order is kept too, and it keeps filling from its own block on", async () => {
    const t = setup(false);
    await t.block(10);
    await t.block(11);
    await t.block(12);
    expect(t.market.send).toHaveBeenCalledTimes(1);
    expect(t.events[2]!.quote).toMatchObject({ status: "resting", txHash: null, orderId: null });
    t.feed.prints.push({ block: 13, side: "sell", size: 500, price: 0 });
    await t.block(13);
    expect(t.events[3]!.fill).toMatchObject({ side: "buy", size: 200, simulated: true });
  });
});

describe("the touch we quote against", () => {
  test("our own order at the top of the book is not the touch: no stepping inside ourselves", async () => {
    const t = setup(true);
    await t.block(1); // bid at 0.023601 (one tick inside 0.0236)
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 501, gasMon: 0 }, canceled: [], minedBlock: 2 });
    // The book now shows our bid on top: 0.023601 x 200 above the others' 0.0236.
    t.market.book = mkBook(0.023601, 0.023606, { levels: { bids: [[0.023601, 200], [0.0236, 2299]], asks: [[0.023606, 819]] } });
    await t.block(2);
    expect(t.market.send.mock.calls[1]![3].bid).toBe(0.0236); // quoted off the others' best bid, not ours
    expect(t.events[1]!.quote!.price).toBe(0.023601);
  });

  test("a level we share with others stays the touch; an unconfirmed order counts as ours too", () => {
    const t = setup(true);
    (t.trader as any).orders.set(501, { side: "buy", price: 0.023601, size: 200, block: 1, txHash: "0x1" });
    (t.trader as any).inflight.set("0x2", { side: "sell", price: 0.023605, size: 200, txHash: "0x2", gasMon: 0, cancel: [], status: "sent", orderId: null, capped: false });
    const touch = (t.trader as any).othersTouch(mkBook(0.023601, 0.023605, { levels: { bids: [[0.023601, 500], [0.0236, 10]], asks: [[0.023605, 200], [0.023606, 5]] } }));
    expect(touch.bid).toBe(0.023601); // 300 of the 500 are someone else's
    expect(touch.ask).toBe(0.023606); // all of 0.023605 is our unconfirmed ask
    expect(touch.mid).toBe((0.023601 + 0.023606) / 2);
  });

  test("simulated (dry-run) orders are not on the book, and an empty top falls back to the raw touch", () => {
    const t = setup(false);
    (t.trader as any).orders.set(-1, { side: "buy", price: 0.0236, size: 200, block: 1, txHash: null });
    const book = mkBook(0.0236, 0.023606);
    expect((t.trader as any).othersTouch(book)).toBe(book);
    const live = setup(true);
    (live.trader as any).orders.set(7, { side: "buy", price: 0.0236, size: 5000, block: 1, txHash: "0x" });
    expect((live.trader as any).othersTouch(mkBook(0.0236, 0.023606, { levels: { bids: [[0.0236, 2299]], asks: [[0.023606, 1]] } })).bid).toBe(0.0236);
  });
});

describe("orders, cancels and margin (live)", () => {
  // Regression: with receipts a block or two late (the README's normal case), every update re-cancelled
  // the ids the unconfirmed update ahead of it was already cancelling. Kuru reverts a cancel of an order
  // that is gone, so 42% of updates reverted at one block of lag, 53% at two.
  test("an update never re-cancels what an unconfirmed update is already cancelling", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 501, gasMon: 0 }, canceled: [], minedBlock: 2 });
    await t.block(2);
    expect(t.market.send.mock.calls[1]![4]).toEqual([501]);
    await t.block(3); // block 2's update (cancelling 501) is still unconfirmed
    expect(t.market.send.mock.calls[2]![4]).toEqual([]);
    t.market.chainSizes.set(501, 200);
    t.market.results.push({ block: 2, quote: { ...t.events[1]!.quote!, status: "reverted", gasMon: 0.04 }, canceled: [], minedBlock: 3 });
    await t.block(4); // it reverted: 501 is still ours to cancel
    await flush();
    expect(t.market.send.mock.calls[3]![4]).toEqual([501]);
  });

  test("a revert re-checks its cancels on chain (gone: dropped, partly filled: resized) and re-reads margin", async () => {
    const t = setup(true);
    await t.block(1);
    await t.block(2);
    t.market.results.push(
      { block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 601, gasMon: 0 }, canceled: [], minedBlock: 2 },
      { block: 2, quote: { ...t.events[1]!.quote!, status: "placed", orderId: 602, gasMon: 0 }, canceled: [], minedBlock: 3 },
    );
    await t.block(3);
    expect(t.market.send.mock.calls[2]![4]).toEqual([601, 602]);
    t.market.chainSizes.set(602, 50); // 601 filled without us seeing it, 602 partly
    t.market.results.push({ block: 3, quote: { ...t.events[2]!.quote!, status: "reverted", gasMon: 0.04 }, canceled: [], minedBlock: 4 });
    await t.block(4);
    await flush();
    expect(t.market.orderSizes).toHaveBeenCalledWith([601, 602]);
    expect(t.market.refreshMargin).toHaveBeenCalledWith(4);
    expect([...(t.trader as any).orders.entries()].map(([id, o]: [number, any]) => [id, o.size])).toEqual([[602, 50]]);
  });

  test("a revert with nothing known to cancel only re-reads margin", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "reverted", gasMon: 0.04 }, canceled: [], minedBlock: 2 });
    await t.block(2);
    await flush();
    expect(t.market.refreshMargin).toHaveBeenCalledTimes(1);
    expect(t.market.orderSizes).not.toHaveBeenCalled();
  });

  test("a failed on-chain re-check changes nothing", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 701, gasMon: 0 }, canceled: [], minedBlock: 2 });
    await t.block(2);
    t.market.orderSizes.mockImplementationOnce(async () => { throw new Error("rpc down"); });
    t.market.refreshMargin.mockImplementationOnce(async () => { throw new Error("rpc down"); });
    t.market.results.push({ block: 2, quote: { ...t.events[1]!.quote!, status: "reverted", gasMon: 0.04 }, canceled: [], minedBlock: 3 });
    await t.block(3);
    await flush();
    expect((t.trader as any).orders.has(701)).toBe(true);
  });

  test("a re-check result for an order dropped meanwhile is ignored", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 711, gasMon: 0 }, canceled: [], minedBlock: 2 });
    await t.block(2);
    let answer!: (m: Map<number, number>) => void;
    t.market.orderSizes.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    t.market.results.push({ block: 2, quote: { ...t.events[1]!.quote!, status: "reverted", gasMon: 0.04 }, canceled: [], minedBlock: 3 });
    await t.block(3);
    t.feed.fills.push({ block: 3, txHash: "0xt", orderId: 711, price: 0.0236, size: 200, updatedSize: 0, side: "buy" });
    (t.trader as any).harvest(); // filled while the re-check was out
    answer(new Map([[711, 200]]));
    await flush();
    expect((t.trader as any).orders.has(711)).toBe(false);
  });

  // Regression: a fill read before the receipt that placed its order used to leave the filled order
  // "resting" for good: every later update cancelled it and reverted, forever.
  test("a fill read before its order's receipt: a full fill never rests, a partial one rests with what is left", async () => {
    const t = setup(true);
    await t.block(1);
    await t.block(2);
    t.feed.fills.push(
      { block: 2, txHash: "0xa", orderId: 801, price: 0.023601, size: 200, updatedSize: 0, side: "buy" },
      { block: 3, txHash: "0xb", orderId: 802, price: 0.023601, size: 150, updatedSize: 50, side: "buy" },
    );
    (t.trader as any).harvest();
    t.market.results.push(
      { block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 801, gasMon: 0 }, canceled: [], minedBlock: 2 },
      { block: 2, quote: { ...t.events[1]!.quote!, status: "placed", orderId: 802, gasMon: 0 }, canceled: [], minedBlock: 3 },
    );
    await t.block(3);
    expect([...(t.trader as any).orders.entries()].map(([id, o]: [number, any]) => [id, o.size])).toEqual([[802, 50]]);
    expect(t.market.send.mock.calls[2]![4]).toEqual([802]);
    expect((t.trader as any).earlyFills.size).toBe(0);
  });

  test("early fills are kept for the newest 500 orders only", () => {
    const t = setup(true);
    for (let id = 1; id <= 510; id++) t.feed.fills.push({ block: 1, txHash: "0x", orderId: id, price: 0.02, size: 1, updatedSize: 0, side: "buy" });
    t.feed.fills.push({ block: 1, txHash: "0x", orderId: 20, price: 0.02, size: 1, updatedSize: 0, side: "buy" }); // seen again: newest now
    (t.trader as any).harvest();
    const kept = [...(t.trader as any).earlyFills.keys()];
    expect(kept.length).toBe(500);
    expect(kept.at(-1)).toBe(20);
    expect(kept[0]).toBe(11); // 1..10 pushed out; 20 moved to the end without evicting
  });

  test("margin moves like Kuru's: a place locks, a cancel gives back what is left, a fill credits the other asset", async () => {
    const t = setup(true);
    await t.block(1); // bid 200 @ 0.023601
    const q1 = t.events[0]!.quote!;
    t.market.results.push({ block: 1, quote: { ...q1, status: "placed", orderId: 901, gasMon: 0 }, canceled: [], minedBlock: 2 });
    await t.block(2);
    t.feed.fills.push({ block: 2, txHash: "0xa", orderId: 901, price: q1.price, size: 120, updatedSize: 80, side: "buy" });
    (t.trader as any).harvest();
    t.market.results.push({ block: 2, quote: { ...t.events[1]!.quote!, status: "placed", orderId: 902, gasMon: 0 }, canceled: [901], minedBlock: 3 });
    await t.block(3);
    const r = (x: number) => Math.round(x * 1e9) / 1e9;
    expect(t.market.moves.map(([b, mon, usdc]) => [b, r(mon), r(usdc)])).toEqual([
      [2, 0, r(-200 * q1.price)], // 901 placed: USDC locked
      [2, 120, 0], // 120 MON bought
      [3, 0, r(80 * q1.price)], // 901 cancelled: the 80 left comes back
      [3, 0, r(-200 * t.events[1]!.quote!.price)], // 902 placed
    ]);
  });

  test("what an update can spend: free margin, plus what its cancels give back, minus what unconfirmed orders lock first", async () => {
    const t = setup(true, () => ({ action: "sell", probabilities: { buy: 0.2, sell: 0.8, hold: 0 }, upIn10: 0.2 }));
    t.market.margin = { mon: 200, usdc: 0 };
    await t.block(1); // 200 free: ask
    expect(t.events[0]!.quote!.side).toBe("sell");
    await t.block(2); // 200 free but the unconfirmed ask will lock it; no USDC either
    expect(t.events[1]!.quote).toBeNull();
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 950, gasMon: 0 }, canceled: [], minedBlock: 2 });
    await t.block(3); // 0 free, but cancelling 950 gives its 200 back first
    expect(t.events[2]!.quote).toMatchObject({ side: "sell", cancel: [950], capped: false });
  });
});

// ------------------------------------------------------------------------------------------------

describe("fills", () => {
  test("dry run: a later taker print through our price fills our simulated order, up to the print size", async () => {
    const t = setup(false);
    await t.block(10); // sim bid at 0.023601
    const bid = t.events[0]!.quote!.price;
    t.feed.prints.push(
      { block: 10, side: "sell", size: 999, price: bid - TICK }, // same block as the order: not on the book yet
      { block: 11, side: "buy", size: 999, price: bid }, // a taker buy never fills a bid
      { block: 11, side: "sell", size: 50, price: bid + TICK }, // above our bid: no
      { block: 11, side: "sell", size: 50, price: bid }, // at our bid: 50
      { block: 12, side: "sell", size: 500, price: bid - TICK }, // through it: the other 150
    );
    (t.trader as any).harvest(); // read before blocks 11 and 12 go out: they carry them
    expect(t.fills).toEqual([]);
    await t.block(11);
    await t.block(12);
    expect(t.fills).toEqual([
      [11, { side: "buy", size: 50, price: bid, txHash: null, orderId: -1, simulated: true }],
      [12, { side: "buy", size: 150, price: bid, txHash: null, orderId: -1, simulated: true }],
    ]);
    expect(t.events.map((e) => e.fill?.size ?? null)).toEqual([null, 50, 150]); // on the block they printed in
    expect(t.events.at(-1)!.position).toMatchObject({ side: "long", size: 200, entryPrice: bid });
    expect(t.events.at(-1)!.totals.fills).toBe(2);
  });

  test("dry run: asks fill on taker buys at or above them", async () => {
    const t = setup(false, () => ({ action: "sell" }));
    await t.block(10);
    const ask = t.events[0]!.quote!.price;
    t.feed.prints.push({ block: 11, side: "buy", size: 1000, price: ask + TICK });
    await t.block(11);
    expect(t.fills).toEqual([[11, { side: "sell", size: 200, price: ask, txHash: null, orderId: -1, simulated: true }]]);
    expect(t.events[1]!.fill).toMatchObject({ side: "sell", size: 200 });
  });

  test("a fill for a block already emitted is attached to that block's history event", async () => {
    const t = setup(true);
    await t.block(10);
    await t.block(11);
    t.feed.fills.push({ block: 10, txHash: "0xt", orderId: 5, price: 0.0236, size: 200, updatedSize: 0, side: "buy" });
    (t.trader as any).harvest();
    expect(t.trader.history[0]!.fill).toMatchObject({ side: "buy", size: 200, simulated: false });
  });

  // Regression: the trade-log poll for block N finishes before block N's decision (one eth_getLogs vs
  // the model call), so its fills used to be harvested before block N's event existed and were never
  // attached; the `fill` SSE went out before its `block` SSE and the dashboard dropped it.
  test("a fill harvested while its own block is still deciding goes out on that block's event, before its fill event", async () => {
    const order: string[] = [];
    const t = setup(false);
    await t.block(10); // simulated bid rests from block 11
    t.feed.prints.push({ block: 11, side: "sell", size: 500, price: 0 }); // a taker prints through it in block 11
    const onEvent = (t.trader as any).onEvent, onFill = (t.trader as any).onFill;
    (t.trader as any).onEvent = (e: BlockEvent, x: Timing) => { order.push(`block ${e.block}`); onEvent(e, x); };
    (t.trader as any).onFill = (b: number, f: Fill) => { order.push(`fill ${b}`); onFill(b, f); };
    await t.block(11); // the poll resolves (and harvests) before the model answers
    expect(t.trader.history.find((e) => e.block === 11)!.fill).toMatchObject({ side: "buy", size: 200 });
    expect(order).toEqual(["block 11", "fill 11"]);
  });

  test("fills for a block that never got an event go out with the next one; fills older than history only reach the listener", async () => {
    config.historySize = 2;
    const t = setup(true);
    await t.block(10);
    await t.block(11);
    await t.block(12); // history: 11, 12
    t.feed.fills.push({ block: 13, txHash: "0xa", orderId: 1, price: 0.0236, size: 20, updatedSize: 0, side: "buy" }); // block 13 errors below
    t.feed.fills.push({ block: 10, txHash: "0xb", orderId: 2, price: 0.0236, size: 30, updatedSize: 0, side: "buy" }); // evicted from history
    (t.trader as any).harvest();
    expect(t.fills).toEqual([[10, { side: "buy", size: 30, price: 0.0236, txHash: "0xb", orderId: 2, simulated: false }]]);
    t.market.readBook.mockImplementationOnce(async () => { throw new Error("rpc down"); });
    await t.block(13);
    await t.block(14);
    expect(t.events.at(-1)!.fill).toMatchObject({ size: 20, txHash: "0xa" });
    expect(t.fills.at(-1)![0]).toBe(14);
  });

  test("a second batch of fills for an emitted block merges into its event", async () => {
    const t = setup(true);
    await t.block(10);
    t.feed.fills.push({ block: 10, txHash: "0xa", orderId: 1, price: 0.02, size: 100, updatedSize: 0, side: "buy" });
    (t.trader as any).harvest();
    t.feed.fills.push({ block: 10, txHash: "0xb", orderId: 2, price: 0.03, size: 100, updatedSize: 0, side: "buy" });
    (t.trader as any).harvest();
    expect(t.trader.history[0]!.fill).toMatchObject({ side: "buy", size: 200, price: 0.025 });
  });

  test("live: our maker fills from the Trade logs; a partial fill shrinks the order, a full one removes it", async () => {
    const t = setup(true);
    await t.block(1);
    t.market.results.push({ block: 1, quote: { ...t.events[0]!.quote!, status: "placed", orderId: 700, gasMon: 0 }, canceled: [], minedBlock: null });
    await t.block(2);
    t.feed.fills.push({ block: 2, txHash: "0xtaker", orderId: 700, price: 0.023601, size: 120, updatedSize: 80, side: "buy" });
    t.feed.prints.push({ block: 2, side: "sell", size: 999, price: 0 }); // live mode never simulates from prints
    (t.trader as any).harvest();
    expect(t.fills).toEqual([[2, { side: "buy", size: 120, price: 0.023601, txHash: "0xtaker", orderId: 700, simulated: false }]]);
    expect((t.trader as any).orders.get(700).size).toBe(80);
    t.feed.fills.push({ block: 3, txHash: "0xtaker2", orderId: 700, price: 0.023601, size: 80, updatedSize: 0, side: "buy" });
    t.feed.fills.push({ block: 3, txHash: "0xtaker3", orderId: 12345, price: 0.0236, size: 10, updatedSize: 5, side: "buy" }); // unknown order: still our inventory
    (t.trader as any).harvest();
    expect((t.trader as any).orders.has(700)).toBe(false);
    await t.block(4);
    expect(t.events.at(-1)!.position).toMatchObject({ side: "long", size: 210 });
  });

  test("several fills in one block become one event: the bigger side, its size and size-weighted price", async () => {
    const t = setup(true);
    await t.block(5);
    t.feed.fills.push(
      { block: 5, txHash: "0xa", orderId: 1, price: 0.02, size: 200, updatedSize: 0, side: "buy" },
      { block: 5, txHash: "0xb", orderId: 2, price: 0.03, size: 100, updatedSize: 0, side: "buy" },
      { block: 5, txHash: "0xc", orderId: 3, price: 0.05, size: 50, updatedSize: 0, side: "sell" },
    );
    (t.trader as any).harvest();
    expect(t.fills).toEqual([[5, { side: "buy", size: 300, price: (200 * 0.02 + 100 * 0.03) / 300, txHash: "0xa", orderId: 1, simulated: false }]]);
    expect((t.trader as any).position.mon).toBe(250); // every fill moves the position, not just the shown side
    expect((t.trader as any).totals.fills).toBe(3);
  });

  test("nothing to harvest without a feed or without fills", () => {
    const t = setup(false);
    (t.trader as any).harvest();
    (t.trader as any).trades = null;
    (t.trader as any).harvest();
    expect(t.fills).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------

describe("P&L", () => {
  const fill = (side: Side, size: number, price: number): Fill => ({ side, size, price, txHash: null, orderId: 1, simulated: true });

  test("average cost in, realize on the way out, flip through zero, flat resets the basis", () => {
    const t = setup(false);
    const tr = t.trader as any;
    tr.applyFill(fill("buy", 200, 0.02));
    tr.applyFill(fill("buy", 200, 0.03));
    expect(tr.position).toEqual({ mon: 400, costUsd: 10 });
    expect(tr.entryPrice()).toBe(0.025);
    tr.applyFill(fill("sell", 100, 0.04)); // +100 x 0.015
    expect(tr.totals.realizedUsd).toBeCloseTo(1.5, 12);
    expect(tr.entryPrice()).toBeCloseTo(0.025, 12);
    tr.applyFill(fill("sell", 500, 0.01)); // closes 300 at -0.015, opens short 200 at 0.01
    expect(tr.totals.realizedUsd).toBeCloseTo(-3, 12);
    expect(tr.position.mon).toBe(-200);
    expect(tr.entryPrice()).toBeCloseTo(0.01, 12);
    expect(tr.unrealizedUsd(0.011)).toBeCloseTo(-200 * 0.001, 12);
    tr.applyFill(fill("buy", 200, 0.005)); // short closes at +0.005
    expect(tr.totals.realizedUsd).toBeCloseTo(-2, 12);
    expect(tr.position).toEqual({ mon: 0, costUsd: 0 });
    expect(tr.entryPrice()).toBeNull();
    expect(tr.unrealizedUsd(0.5)).toBe(0);
    expect(tr.totals.fills).toBe(5);
  });

  test("zero-size fills are ignored", () => {
    const t = setup(false);
    (t.trader as any).applyFill(fill("buy", 0, 0.02));
    expect((t.trader as any).totals.fills).toBe(0);
  });

  test("the block event: unrealized at mid, realized, gas in USD, P&L in USD, MON and % of bankroll", async () => {
    config.bankrollUsd = 50;
    const t = setup(false);
    const tr = t.trader as any;
    tr.applyFill(fill("buy", 400, 0.02));
    tr.applyFill(fill("sell", 200, 0.022)); // realized +0.4, long 200 @ 0.02
    tr.totals.gasMon = 2;
    t.market.book = mkBook(0.0249, 0.0251); // mid 0.025
    await t.block(1);
    const e = t.events[0]!;
    expect(e.position).toEqual({ side: "long", size: 200, entryPrice: 0.02, unrealizedUsd: 1, unrealizedMon: 40 });
    const pnl = 0.4 + 1 - 2 * 0.025 - e.totals.jevUsd;
    expect(e.totals).toMatchObject({ realizedUsd: 0.4, gasMon: 2, gasUsd: 0.05, pnlUsd: Math.round(pnl * 1e4) / 1e4, pnlMon: Math.round((pnl / 0.025) * 1e4) / 1e4, pnlPct: Math.round((pnl / 50) * 100 * 1000) / 1000 });
    tr.applyFill(fill("sell", 400, 0.025));
    await t.block(2);
    expect(t.events[1]!.position).toMatchObject({ side: "short", size: 200, entryPrice: 0.025 });
  });
});

// ------------------------------------------------------------------------------------------------
// Real Market on the practice exchange, block by block.

describe("live loop on the practice exchange", () => {
  let ex: PracticeExchange;
  const quiet = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
  afterAll(() => quiet.forEach((s) => s.mockRestore()));
  afterEach(() => ex?.stop());

  async function liveTrader(opts: Parameters<typeof startPracticeExchange>[0], decide: (b: number) => Side | Promise<Side> = () => "buy", margin: [number, number] = [600, 20]) {
    ex = startPracticeExchange({ takersPerBlock: 0, volBps: 0, ...opts });
    config.rpcUrl = config.readRpcUrl = ex.url;
    config.dryRun = false;
    config.privateKey = ethers.Wallet.createRandom().privateKey;
    [config.marginMon, config.marginUsdc] = margin; // already funded: no startup deposits
    const market = new Market();
    ex.setMargin(market.address!, ...margin);
    await market.init();
    const events: BlockEvent[] = [], fills: [number, Fill][] = [];
    const model = { name: "scripted", decide: async (s: TradeState): Promise<Decision> => {
      const a = await decide(s.block);
      return { action: a, probabilities: { buy: a === "buy" ? 0.8 : 0.2, sell: a === "buy" ? 0.2 : 0.8, hold: 0 }, upIn10: a === "buy" ? 0.8 : 0.2, latencyMs: 1, inputTokens: 10 };
    } };
    const trader = new Trader(market, model, (e) => events.push(e), (b, f) => fills.push([b, f]));
    trader.attachTradeFeed(10);
    /** Mine a block, run the loop on it, and let receipts and the trade-log poll land. */
    const step = async () => { ex.mine(); await trader.onBlock(ex.block); await Bun.sleep(25); };
    return { market, trader, events, fills, step };
  }

  test("every block: one batchUpdate that cancels the last order and posts the next; receipts and fills flow back", async () => {
    const { trader, events, fills, step } = await liveTrader({ seed: 21 }, async (b) => {
      // This scenario asserts one confirmed cancellation per replacement. Receipt polling and
      // book reads race, so explicitly wait for the prior receipt before the scripted decision.
      // The separate delayed-receipt scenarios below exercise decisions that overtake receipts.
      await until(() => trader.history.at(-1)?.quote?.status !== "sent", 3000, "prior order receipt");
      return b % 2 ? "buy" : "sell";
    });
    for (let i = 0; i < 6; i++) await step();
    ex.taker(true, 100_000); ex.taker(false, 100_000); // sweep both sides: whatever we have resting fills
    for (let i = 0; i < 4; i++) await step();
    const quotes = trader.history.map((e) => e.quote!);
    expect(quotes.every((q) => q && q.txHash)).toBe(true);
    expect(quotes.slice(0, 6).every((q) => q.status === "placed")).toBe(true);
    for (let i = 1; i < 6; i++) expect(quotes[i]!.cancel).toEqual([quotes[i - 1]!.orderId!]); // each cancels the one before
    // The sweep filled what was resting. The next update may still cancel that id and revert once (as the
    // README says); after that the loop is back to clean updates.
    const settled = quotes.slice(6).filter((q) => q.status !== "sent");
    expect(settled.at(-1)!.status).toBe("placed");
    expect(ex.stats(trader["market"].address!).reverted).toBeLessThanOrEqual(1);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every(([, f]) => !f.simulated && f.txHash)).toBe(true);
    expect(events.at(-1)!.totals.gasMon).toBeGreaterThan(0);
    expect([...ex.orders.values()].length).toBeLessThanOrEqual(2);
  });

  // Regression: margin used to be re-read only every REFRESH_BLOCKS (200 blocks, ~60 s), so once fills
  // used up one asset the bot kept sending orders it could not fund; in a 600-block practice session 76%
  // of updates reverted (InsufficientBalance) and 32% of quotes went against the model's call.
  test("once fills use up an asset, that side stops quoting without a single unfunded order", async () => {
    const { trader, market, step } = await liveTrader({ seed: 23 }, () => "sell", [200, 20]); // one ask's worth of MON
    await step(); // ask sent
    await step(); // placed (200 MON locked) and replaced, same size
    ex.taker(true, 1_000_000); // a taker lifts it: no MON left
    for (let i = 0; i < 8; i++) await step();
    const st = ex.stats(market.address!);
    expect(st.revertReasons.InsufficientBalance ?? 0).toBe(0);
    expect(st.reverted).toBeLessThanOrEqual(1); // at most the one update that cancelled the order as it filled (README)
    expect(trader.history.slice(-4).every((e) => e.quote!.side === "buy" && e.quote!.capped)).toBe(true);
    expect(market.margin.mon).toBeCloseTo(ex.margin(market.address!).mon, 6); // the bot's books match the chain
    expect(market.margin.usdc).toBeCloseTo(ex.margin(market.address!).usdc, 5);
  });

  test("margin changed behind the bot's back costs one revert, then it re-reads and stops", async () => {
    const { trader, market, step } = await liveTrader({ seed: 24 }, () => "sell");
    ex.setMargin(market.address!, 0, 20); // out of band: the bot still thinks it has 600 MON
    for (let i = 0; i < 8; i++) await step();
    // The first revert comes back a block later, while the next update is already built: at most those two.
    expect(ex.stats(market.address!).revertReasons.InsufficientBalance).toBeLessThanOrEqual(2);
    expect(trader.history.slice(-5).every((e) => e.quote!.status !== "reverted")).toBe(true);
    expect(market.margin.mon).toBe(0);
    expect(trader.history.slice(-3).every((e) => e.quote!.side === "buy" && e.quote!.capped)).toBe(true);
  });

  // Regression: a fill seen before its placing receipt used to leave a phantom resting order that every
  // later update cancelled, so every block reverted from then on.
  test("a fill seen before its placing receipt leaves no phantom order", async () => {
    const { trader, step } = await liveTrader({ seed: 22, receiptLagBlocks: 2 });
    await step(); // B1: warm-up poll; buy sent
    ex.taker(false, 1_000_000); // B2: our bid is included, then swept in the same block
    await step(); // fill log seen now; receipt not until B4
    for (let i = 0; i < 10; i++) await step();
    const settled = trader.history.slice(2).map((e) => e.quote?.status).filter((s) => s !== "sent");
    expect(settled.length).toBeGreaterThanOrEqual(5);
    expect(settled).not.toContain("reverted");
    const swept = trader.history[0]!.quote!.orderId!;
    expect(ex.orders.has(swept)).toBe(false);
    expect((trader as any).orders.has(swept)).toBe(false); // it never comes back as "resting"
  });

  for (const lag of [1, 2]) {
    test(`receipts ${lag} block${lag > 1 ? "s" : ""} late: no update reverts on a double cancel, and the book holds only our latest order or two`, async () => {
      const { trader, market, step } = await liveTrader({ seed: 25, receiptLagBlocks: lag }, (b) => (b % 2 ? "buy" : "sell"), [5000, 200]);
      for (let i = 0; i < 20; i++) await step();
      const st = ex.stats(market.address!);
      expect(st.revertReasons).toEqual({});
      expect(st.placed).toBeGreaterThanOrEqual(19);
      expect(ex.orders.size).toBeLessThanOrEqual(lag + 1);
      expect(trader.history.length).toBe(20);
    });
  }
});
