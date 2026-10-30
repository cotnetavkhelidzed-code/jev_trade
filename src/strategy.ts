import type { Book, Side } from "./market";
import type { TradePrint } from "./trades";
import { RULEBOOK } from "./rulebook";

export interface StrategySettings {
  horizon: number; minSamples: number; minFills: number; minEdgeUsd: number;
  uncertainty: number; exitBps: number; maxLossUsd: number; maxVolBps: number;
}
interface Trial { key: string; side: Side; block: number; price: number; size: number; left: number; queue: number; filled: number; cash: number; due: number }
interface Stats { n: number; fills: number; sum: number; sum2: number; fraction: number }
export interface Gate {
  rulebook: string; action: "place" | "keep" | "skip"; reason: string; key: string;
  samples: number; fills: number; fillFraction: number; expectedNetUsd: number | null; lowerNetUsd: number | null;
  side: Side; price: number; size: number;
}
export const volatilityBps = (mids: number[]) => {
  const r = mids.slice(1).map((m, i) => Math.log(m / mids[i]!) * 1e4);
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
};

/** Non-overlapping shadow orders per bucket bootstrap without spending money. Scores are
 * per submitted notional, include zero fills and conditional adverse selection, and mature
 * only after order expiry plus the markout horizon. No future book is used to simulate a fill. */
export class Strategy {
  private trials: Trial[] = [];
  private stats = new Map<string, Stats>();
  constructor(readonly settings: StrategySettings) {
    if (!Object.values(settings).every(Number.isFinite) || settings.horizon < 1 || settings.minSamples < 2 || settings.minFills < 1 || ![settings.horizon, settings.minSamples, settings.minFills].every(Number.isInteger) || settings.uncertainty < 0 || settings.exitBps < 0 || settings.maxLossUsd <= 0 || settings.maxVolBps <= 0 || settings.minEdgeUsd < 0) throw new Error("Invalid strategy settings");
  }
  advance(block: number, mid: number, prints: TradePrint[], makerFeeBps: number) {
    for (const t of this.trials) {
      for (const p of prints) {
        if (p.block <= t.block || p.block > t.block + this.settings.horizon || t.left <= 0) continue;
        if (!(t.side === "buy" ? p.side === "sell" && p.price <= t.price : p.side === "buy" && p.price >= t.price)) continue;
        // At equal price, all visible volume ahead must trade first. Through-price prints
        // still consume that queue: deliberately conservative with L2-only observations.
        const ahead = Math.min(t.queue, p.size); t.queue -= ahead;
        const size = Math.min(t.left, p.size - ahead);
        t.left -= size; t.filled += size; t.cash += size * t.price;
      }
      if (block < t.due) continue;
      const sign = t.side === "buy" ? 1 : -1;
      const marked = sign * (t.filled * mid - t.cash);
      const costs = t.cash * (makerFeeBps + this.settings.exitBps) / 1e4;
      const x = (marked - costs) / (t.size * t.price);
      const s = this.stats.get(t.key) ?? { n: 0, fills: 0, sum: 0, sum2: 0, fraction: 0 };
      s.n++; s.fills += Number(t.filled > 0); s.sum += x; s.sum2 += x * x; s.fraction += t.filled / t.size;
      this.stats.set(t.key, s);
    }
    this.trials = this.trials.filter(t => block < t.due);
  }
  evaluate(input: { block: number; book: Book; side: Side; probability: number; price: number; size: number; gasUsd: number; inferenceUsd: number; pnlUsd: number; volatility: number; allowed: boolean; keeping: boolean; fresh?: boolean }): Gate {
    const i = input;
    const offset = Math.abs(i.price - i.book.mid) / i.book.mid * 1e4;
    const key = `${i.side}:${Math.floor(i.probability * 5)}:${Math.round(offset)}:${Math.floor(i.volatility / 5)}`;
    const s = this.stats.get(key);
    const mean = s ? s.sum / s.n : 0;
    const variance = s && s.n > 1 ? Math.max(0, (s.sum2 - s.sum ** 2 / s.n) / (s.n - 1)) : 0;
    const net = mean * i.price * i.size - i.gasUsd - i.inferenceUsd;
    const lower = net - this.settings.uncertainty * Math.sqrt(variance / (s?.n || 1)) * i.price * i.size;
    let reason = "positive-net-edge";
    if (![i.book.bid, i.book.ask, i.book.mid, i.price, i.size, i.probability, i.volatility, i.gasUsd, i.inferenceUsd, i.pnlUsd].every(Number.isFinite) || i.book.bid <= 0 || i.book.mid <= 0 || i.price <= 0 || i.book.ask <= i.book.bid || i.size <= 0 || i.probability < 0 || i.probability > 1 || i.gasUsd < 0 || i.inferenceUsd < 0 || (i.side === "buy" ? i.price >= i.book.ask : i.price <= i.book.bid)) reason = "invalid-market-data";
    else if (i.fresh === false) reason = "stale-decision";
    else if (i.pnlUsd <= -this.settings.maxLossUsd) reason = "loss-limit";
    else if (i.volatility > this.settings.maxVolBps) reason = "volatility-limit";
    else if (!i.allowed) reason = "inventory-or-funds-limit";
    else if (!s || s.n < this.settings.minSamples || s.fills < this.settings.minFills) reason = "collecting-shadow-evidence";
    else if (lower <= this.settings.minEdgeUsd) reason = "insufficient-net-edge";
    if (reason !== "invalid-market-data" && reason !== "stale-decision" && !this.trials.some(t => t.key === key)) {
      const levels = i.side === "buy" ? i.book.levels.bids : i.book.levels.asks;
      const queue = levels.filter(([p]) => i.side === "buy" ? p >= i.price : p <= i.price).reduce((a, [, size]) => a + size, 0);
      this.trials.push({ key, side: i.side, block: i.block, price: i.price, size: i.size, left: i.size, queue, filled: 0, cash: 0, due: i.block + this.settings.horizon * 2 });
    }
    return { rulebook: RULEBOOK.version, action: reason === "positive-net-edge" ? i.keeping ? "keep" : "place" : "skip", reason, key, samples: s?.n ?? 0, fills: s?.fills ?? 0, fillFraction: s ? s.fraction / s.n : 0, expectedNetUsd: s ? net : null, lowerNetUsd: s ? lower : null, side: i.side, price: i.price, size: i.size };
  }
}

/** Actual fills, each measured once at 1s/10s/30s (rounded up to blocks). */
export class Markouts {
  private pending: { block: number; side: Side; price: number; size: number; horizons: number[] }[] = [];
  add(block: number, fill: { side: Side; price: number; size: number }) { this.pending.push({ block, ...fill, horizons: [4, 34, 100] }); }
  advance(block: number, mid: number) {
    const out: { fillBlock: number; observedBlock: number; horizonBlocks: number; side: Side; size: number; markoutBps: number }[] = [];
    for (const f of this.pending) {
      for (const h of f.horizons.filter(h => block >= f.block + h)) out.push({ fillBlock: f.block, observedBlock: block, horizonBlocks: h, side: f.side, size: f.size, markoutBps: (f.side === "buy" ? 1 : -1) * (mid / f.price - 1) * 1e4 });
      f.horizons = f.horizons.filter(h => block < f.block + h);
    }
    this.pending = this.pending.filter(f => f.horizons.length);
    return out;
  }
}
