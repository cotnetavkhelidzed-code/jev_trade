import type { Book, Side } from "./market";
import type { Decision, TradeState } from "./model";
import type { TradePrint } from "./trades";
import { Strategy, type StrategySettings } from "./strategy";
import { RULEBOOK } from "./rulebook";

export interface ResearchFrame { version: number; rulebook: string; block: number; book: Book; prints: TradePrint[]; state: TradeState; decision: Decision; makerFeeBps: number; minOrderMon: number; tick: number; settings: StrategySettings }
export interface ReplayOptions { splitBlock: number; startMon: number; startUsdc: number; maxPosition: number; size: number; latencyBlocks: number; requoteTicks: number }
interface Order { side: Side; price: number; size: number; queue: number; quotedAt: number; start: number; end?: number }
/** Frozen recorded Jev forecasts, with independently simulated balances/execution. Online
 * estimates learn only from matured past observations; no parameter search occurs here. */
export async function replay(frames: AsyncIterable<ResearchFrame> | Iterable<ResearchFrame>, options: ReplayOptions) {
  if (!Object.values(options).every(Number.isFinite) || options.splitBlock < 0 || options.startMon < 0 || options.startUsdc < 0 || options.maxPosition <= 0 || options.size <= 0 || options.latencyBlocks < 1 || options.requoteTicks < 0) throw new Error("Invalid replay options");
  let strategy: Strategy | null = null, previous = -1, mid = 0, startMid = 0;
  let mon = options.startMon, cash = options.startUsdc, gas = 0, inference = 0, fees = 0, fills = 0, reverts = 0, sent = 0, kept = 0, drawdown = 0, peak = 0, start = 0, tested = 0, trained = 0;
  let order: Order | null = null;
  let retired: Order[] = [];
  let pending: { due: number; next: Order | null; gas: number } | null = null;
  const reasons: Record<string, number> = {};
  let settings = "";
  for await (const f of frames) {
    if (f.version !== 1 || f.rulebook !== RULEBOOK.version || !Number.isInteger(f.block) || f.block <= previous || ![f.book.mid, f.book.bid, f.book.ask, f.tick, f.minOrderMon, f.makerFeeBps].every(Number.isFinite) || f.tick <= 0 || f.minOrderMon <= 0 || f.book.bid <= 0 || f.book.ask <= f.book.bid || f.prints.some(p => p.block > f.block || p.price <= 0 || p.size <= 0)) throw new Error("Invalid, unordered or incompatible research frame");
    previous = f.block; mid = f.book.mid;
    if (!strategy) { strategy = new Strategy(f.settings); settings = JSON.stringify(f.settings); }
    if (JSON.stringify(f.settings) !== settings) throw new Error("Settings changed within recording; split the recording first");
    strategy.advance(f.block, mid, f.prints, f.makerFeeBps);
    const test = f.block >= options.splitBlock;
    if (test && !tested) { startMid = mid; start = mon * mid + cash; peak = start; }
    if (test) tested++; else trained++;
    if (test) {
      inference += (f.state.execution as (TradeState["execution"] & { inferenceUsd?: number }))?.inferenceUsd ?? 0;
      if (pending && f.block >= pending.due) {
        gas += pending.gas;
        const q = pending.next;
        if (q && (q.side === "buy" ? q.price >= f.book.ask : q.price <= f.book.bid)) reverts++;
        else {
          if (order) retired.push({ ...order, end: pending.due });
          order = q;
        }
        pending = null;
      }
      for (const p of f.prints) {
        const resting = [...retired, ...(order ? [order] : [])].find(o => p.block >= o.start && p.block < (o.end ?? Infinity) && o.size > 0);
        if (!resting || !(resting.side === "buy" ? p.side === "sell" && p.price <= resting.price : p.side === "buy" && p.price >= resting.price)) continue;
        const ahead = Math.min(resting.queue, p.size); resting.queue -= ahead;
        const size = Math.min(resting.size, p.size - ahead, resting.side === "buy" ? cash / resting.price : mon);
        if (size <= 0) continue;
        const notional = size * resting.price, fee = notional * f.makerFeeBps / 1e4;
        mon += (resting.side === "buy" ? size : -size); cash += (resting.side === "buy" ? -notional : notional) - fee;
        fees += fee; fills++; resting.size -= size;
        if (order && order.size < 1e-9) order = null;
      }
    }
    if (f.prints.length) retired = retired.filter(o => o.end! > Math.max(...f.prints.map(p => p.block)));
    const side: Side = f.decision.action === "sell" ? "sell" : "buy";
    const vol = f.state.execution?.volatilityBps ?? 0, inventory = mon - options.startMon;
    const size = Math.min(options.size, Math.max(f.minOrderMon, Math.floor(options.size / (1 + vol / 10 + Math.abs(inventory) / options.maxPosition) / f.minOrderMon) * f.minOrderMon));
    let price = side === "buy" ? f.book.bid + f.tick : f.book.ask - f.tick;
    if (price >= f.book.ask || price <= f.book.bid) price = side === "buy" ? f.book.bid : f.book.ask;
    price += (side === "buy" ? -1 : 1) * Math.ceil(vol / 5 + Math.abs(inventory) / options.maxPosition * 2) * f.tick;
    price = Math.round(price / f.tick) * f.tick;
    const keeping = !!order && f.block - order.quotedAt < strategy.settings.horizon && order.side === side && Math.abs(order.size - size) < 1e-9 && Math.abs(order.price - price) <= options.requoteTicks * f.tick && (side === "buy" ? order.price < f.book.ask : order.price > f.book.bid);
    const gasUsd = f.state.execution?.gasUsd ?? 0;
    const gate = strategy.evaluate({ block: f.block, book: f.book, side, probability: f.decision.probabilities[side], price: keeping ? order!.price : price, size, gasUsd: keeping ? 0 : gasUsd, inferenceUsd: (f.state.execution as (TradeState["execution"] & { inferenceUsd?: number }))?.inferenceUsd ?? 0, pnlUsd: test ? (mon - options.startMon) * mid + cash - options.startUsdc - gas - inference : 0, volatility: vol, allowed: size >= f.minOrderMon && Math.abs(inventory + (side === "buy" ? size : -size)) <= options.maxPosition && (side === "buy" ? cash >= size * price : mon >= size), keeping });
    if (!test) continue;
    reasons[gate.reason] = (reasons[gate.reason] ?? 0) + 1;
    if (!pending) {
      if (gate.action === "keep") kept++;
      else if (gate.action === "place" || order) {
        const queue = (side === "buy" ? f.book.levels.bids : f.book.levels.asks).filter(([p]) => side === "buy" ? p >= price : p <= price).reduce((a, [, s]) => a + s, 0);
        pending = { due: f.block + Math.max(options.latencyBlocks, Math.ceil(f.decision.latencyMs / 300)), next: gate.action === "place" ? { side, price, size, queue, quotedAt: f.block, start: f.block + Math.max(options.latencyBlocks, Math.ceil(f.decision.latencyMs / 300)) } : null, gas: gasUsd };
        sent++;
      }
    }
    const equity = mon * mid + cash - gas - inference;
    peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity);
  }
  if (!tested || !strategy) throw new Error("No test frames; choose a split inside the recording");
  // Charge unresolved sends too; their execution outcome is unknown at the recording boundary.
  if (pending) gas += pending.gas;
  const end = mon * mid + cash - gas - inference;
  const unwind = Math.abs(mon - options.startMon) * mid * strategy.settings.exitBps / 1e4;
  return { rulebook: RULEBOOK.version, options, trained, tested, netPnlUsd: end - start, vsHoldUsd: end - (options.startMon * mid + options.startUsdc), liquidationAdjustedVsHoldUsd: end - (options.startMon * mid + options.startUsdc) - unwind, drawdownUsd: drawdown, gasUsd: gas, inferenceUsd: inference, feesUsd: fees, mon, cash, fills, sent, kept, reverts, reasons, startMid, endMid: mid, unresolvedTransaction: !!pending, openOrderMon: order?.size ?? 0 };
}
