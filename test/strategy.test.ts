import { describe, test, expect } from "bun:test";
import { Strategy, Markouts, volatilityBps, type StrategySettings } from "../src/strategy";
import { RULEBOOK } from "../src/rulebook";
import { replay, type ResearchFrame } from "../src/replay";
import type { Book } from "../src/market";
const settings: StrategySettings = { horizon: 2, minSamples: 2, minFills: 2, minEdgeUsd: 0, uncertainty: 2, exitBps: 0, maxLossUsd: 5, maxVolBps: 30 };
const book: Book = { block: 1, bid: 99, ask: 103, mid: 101, spreadBps: 396, imbalance: 0, levels: { bids: [[99, 2]], asks: [[103, 2]] }, depthBps: {} };
const input = (block: number, o = {}) => ({ block, book, side: "buy" as const, probability: .8, price: 100, size: 10, gasUsd: .1, inferenceUsd: .01, pnlUsd: 0, volatility: 0, allowed: true, keeping: false, ...o });
function train(s: Strategy, fee = 0, mid = 101) {
  for (const block of [1, 6]) {
    s.evaluate(input(block));
    s.advance(block + 1, mid, [{ block: block + 1, price: 100, side: "sell", size: 10 }], fee);
    s.advance(block + 4, mid, [], fee);
  }
}
describe("book-based execution", () => {
  test("warmup fails closed and future markouts cannot leak into current decisions", () => {
    const s = new Strategy(settings);
    expect(s.evaluate(input(1)).reason).toBe("collecting-shadow-evidence");
    s.advance(2, 101, [{ block: 2, price: 100, side: "sell", size: 10 }], 0);
    expect(s.evaluate(input(3)).samples).toBe(0);
    s.advance(5, 101, [], 0);
    expect(s.evaluate(input(5)).samples).toBe(1);
  });
  test("positive fill evidence can permit orders; gas, exit fees and risk can veto them", () => {
    const s = new Strategy(settings); train(s);
    expect(s.evaluate(input(11)).action).toBe("place");
    expect(s.evaluate(input(11, { keeping: true, gasUsd: 0 })).action).toBe("keep");
    expect(s.evaluate(input(11, { gasUsd: 20 })).reason).toBe("insufficient-net-edge");
    expect(s.evaluate(input(11, { allowed: false })).reason).toBe("inventory-or-funds-limit");
    expect(s.evaluate(input(11, { pnlUsd: -5 })).reason).toBe("loss-limit");
    expect(s.evaluate(input(11, { volatility: 31 })).reason).toBe("volatility-limit");
    const expensive = new Strategy({ ...settings, exitBps: 200 }); train(expensive);
    expect(expensive.evaluate(input(11)).action).toBe("skip");
  });
  test("adverse fills lose despite high model confidence", () => {
    const s = new Strategy(settings); train(s, 0, 99);
    expect(s.evaluate(input(11)).reason).toBe("insufficient-net-edge");
  });
  test("zero fills and queue ahead cannot fabricate an edge", () => {
    const s = new Strategy(settings);
    for (const b of [1, 6]) {
      s.evaluate(input(b, { price: 99 }));
      s.advance(b + 1, 101, [{ block: b + 1, side: "sell", size: 2, price: 99 }], 0);
      s.advance(b + 4, 101, [], 0);
    }
    const gate = s.evaluate(input(11, { price: 99 }));
    expect(gate.samples).toBe(2); expect(gate.fills).toBe(0); expect(gate.action).toBe("skip");
  });
  test("partial fills scale returns, negative fees are rebates, and missing values fail closed", () => {
    const s = new Strategy(settings); train(s, -10);
    expect(s.evaluate(input(11)).expectedNetUsd).toBeGreaterThan(10);
    expect(s.evaluate(input(11, { price: NaN })).reason).toBe("invalid-market-data");
    expect(s.evaluate(input(11, { probability: 2 })).action).toBe("skip");
    expect(() => new Strategy({ ...settings, uncertainty: NaN })).toThrow();
    expect(volatilityBps([100, 100, 100])).toBe(0);
  });
  test("actual fill markouts mature once at each horizon and preserve side", () => {
    const m = new Markouts(); m.add(10, { side: "sell", price: 100, size: 10 });
    expect(m.advance(13, 99)).toEqual([]);
    expect(m.advance(14, 99)[0]!.markoutBps).toBeCloseTo(100);
    expect(m.advance(14, 99)).toEqual([]);
    expect(m.advance(110, 101).map(x => x.horizonBlocks)).toEqual([34, 100]);
  });
});
const frame = (block: number): ResearchFrame => ({ version: 1, rulebook: RULEBOOK.version, block, book: { ...book, block }, prints: block % 5 === 2 ? [{ block, side: "sell", price: 100, size: 10 }] : [], state: { execution: { volatilityBps: 0, gasUsd: .1, inferenceUsd: .01 } } as any, decision: { action: "buy", probabilities: { buy: .8, sell: .2, hold: 0 }, latencyMs: 1, inputTokens: 1000, upIn10: .8 }, settings, tick: 1, minOrderMon: 10, makerFeeBps: 0 });
const options = { splitBlock: 11, startMon: 10, startUsdc: 5000, maxPosition: 100, size: 10, latencyBlocks: 2, requoteTicks: 5 };
test("recorded replay is chronological, repeatable, includes costs and reports a hold benchmark", async () => {
  const frames = Array.from({ length: 25 }, (_, i) => frame(i + 1));
  const a = await replay(frames, options), b = await replay(frames, options);
  expect(a).toEqual(b); expect(a.trained).toBe(10); expect(a.tested).toBe(15);
  expect(a.inferenceUsd).toBeCloseTo(.15); expect(a.sent).toBeGreaterThan(0);
  expect(Number.isFinite(a.vsHoldUsd)).toBe(true);
  await expect(replay([frame(2), frame(1)], options)).rejects.toThrow();
  await expect(replay([{ ...frame(1), prints: [{ block: 2, price: 100, size: 1, side: "sell" }] }], options)).rejects.toThrow();
});

test("replay replaces an otherwise suitable order after its quote horizon", async () => {
  const frames = Array.from({ length: 14 }, (_, i) => frame(i + 1));
  // Train on fills, then leave the test order untouched and the market unchanged.
  for (const f of frames) if (f.block >= options.splitBlock) f.prints = [];
  const result = await replay(frames, { ...options, latencyBlocks: 1 });
  expect(result.fills).toBe(0);
  expect(result.sent).toBe(2);
  expect(result.gasUsd).toBeCloseTo(.2);
});

test("partial shadow fills contribute only filled notional; stale decisions cannot seed evidence", () => {
  const s = new Strategy(settings);
  expect(s.evaluate(input(0, { fresh: false })).reason).toBe("stale-decision");
  for (const b of [1, 6]) {
    s.evaluate(input(b));
    s.advance(b + 1, 101, [{ block: b + 1, side: "sell", price: 100, size: 5 }], 0);
    s.advance(b + 4, 101, [], 0);
  }
  const g = s.evaluate(input(11));
  expect(g.fillFraction).toBe(.5);
  expect(g.expectedNetUsd).toBeCloseTo(4.89);
});
