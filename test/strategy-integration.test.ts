import { test, expect } from "bun:test";
import { config } from "../src/config";
import { Trader } from "../src/trader";
import type { Book, Market } from "../src/market";
import { inTempDir, isolateConfig, flush } from "./helpers";
inTempDir(); isolateConfig();
test("default strategy evaluates every block, skips warmup, records context, and never reverses blocked forecasts", async () => {
  config.strategyEnabled = true; config.strategyMinSamples = 2; config.strategyMinFills = 2; config.horizonBlocks = 2;
  let calls = 0, sends = 0;
  const book: Book = { block: 1, bid: 100, ask: 104, mid: 102, spreadBps: 392, imbalance: 0, levels: { bids: [[100, 1]], asks: [[104, 1]] }, depthBps: {} };
  const market = { wallet: null, margin: { mon: 600, usdc: 20 }, tick: 1, minOrderMon: 200, makerFeeBps: 0, estimatedGasUsd: () => .001, quotePrice: () => 101, readBook: async () => book, pollPending: async () => [], send: async () => { sends++; throw new Error("Must not send during warmup"); } } as unknown as Market;
  const model = { name: "jev-test", decide: async (state: any) => { calls++; expect(state.portfolio).toBeDefined(); expect(state.execution.rulebook).toContain("cartea"); return { action: "buy" as const, probabilities: { buy: .9, sell: .1, hold: 0 }, upIn10: .9, inputTokens: 1000, latencyMs: 1 }; } };
  const trader = new Trader(market, model, () => {});
  for (let b = 1; b <= 3; b++) { book.block = b; await trader.onBlock(b); await flush(); }
  expect(calls).toBe(3); expect(sends).toBe(0);
  expect(trader.history.at(-1)!.decision).toMatchObject({ action: "hold", late: false });
  expect(trader.history.at(-1)!.strategy!.reason).toBe("collecting-shadow-evidence");
  expect(trader.history.at(-1)!.totals.pnlUsd).toBeLessThan(0);
  const rows = (await Bun.file("data/research.jsonl").text()).trim().split("\n").map(JSON.parse);
  expect(rows.length).toBe(3); expect(rows[0].state.execution.inferenceUsd).toBeGreaterThan(0);
});

test("matured positive evidence places and keeps an order; inventory veto clears it without selling", async () => {
  Object.assign(config, { strategyEnabled: true, strategyMinSamples: 2, strategyMinFills: 2, horizonBlocks: 2, exitCostBps: 0, minEdgeUsd: 0, tradeSizeMon: 200, maxPositionMon: 1000, quoteEveryBlock: true });
  const book: Book = { block: 11, bid: 100, ask: 104, mid: 102, spreadBps: 392, imbalance: 0, levels: { bids: [[100, 1]], asks: [[104, 1]] }, depthBps: {} };
  const sent: any[] = [];
  const market = { wallet: null, margin: { mon: 600, usdc: 20 }, tick: 1, minOrderMon: 200, makerFeeBps: 0, estimatedGasUsd: () => .001, quotePrice: () => 101, readBook: async () => book, pollPending: async () => [], send: async (...args: any[]) => { sent.push(args); return { side: args[1], size: args[2], price: args[6], txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false }; } } as unknown as Market;
  const model = { name: "mock", decide: async () => ({ action: "buy" as const, probabilities: { buy: .9, sell: .1, hold: 0 }, upIn10: .9, inputTokens: 0, latencyMs: 1 }) };
  const t = new Trader(market, model, () => {}), s = (t as any).strategy;
  for (const b of [1, 6]) {
    s.evaluate({ block: b, book, side: "buy", probability: .9, price: 101, size: 200, gasUsd: .001, inferenceUsd: 0, pnlUsd: 0, volatility: 0, allowed: true, keeping: false });
    s.advance(b + 1, 102, [{ block: b + 1, side: "sell", price: 101, size: 200 }], 0);
    s.advance(b + 4, 102, [], 0);
  }
  await t.onBlock(11); expect(sent.length).toBe(1); expect(t.history.at(-1)!.strategy!.action).toBe("place");
  book.block = 12; await t.onBlock(12); expect(sent.length).toBe(1); expect(t.history.at(-1)!.quote!.status).toBe("resting");
  (t as any).position.mon = 1000;
  book.block = 13; await t.onBlock(13);
  expect(t.history.at(-1)!.strategy!.reason).toBe("inventory-or-funds-limit");
  expect(sent.length).toBe(1); expect((t as any).orders.size).toBe(0);
});

test("a failed gate sends cancel-only for confirmed live orders and reserves its receipt", async () => {
  config.strategyEnabled = true;
  const sent: any[] = [];
  const book: Book = { block: 1, bid: 100, ask: 104, mid: 102, spreadBps: 392, imbalance: 0, levels: { bids: [[100, 1]], asks: [[104, 1]] }, depthBps: {} };
  const market = { wallet: {}, margin: { mon: 0, usdc: 0 }, tick: 1, minOrderMon: 200, makerFeeBps: -1, estimatedGasUsd: () => .01, quotePrice: () => 101, readBook: async () => book, pollPending: async () => [], accountSnapshot: async () => null, send: async (...args: any[]) => { sent.push(args); return { side: args[1], size: args[2], price: 101, txHash: "0xcancel", gasMon: .01, cancel: args[4], status: "sent", orderId: null, capped: false }; } } as unknown as Market;
  const model = { name: "mock", decide: async () => ({ action: "buy" as const, probabilities: { buy: .8, sell: .2, hold: 0 }, upIn10: .8, inputTokens: 0, latencyMs: 1 }) };
  const t = new Trader(market, model, () => {});
  (t as any).orders.set(9, { side: "sell", price: 103, size: 200, block: 0, txHash: "0xold" });
  await t.onBlock(1); await flush();
  expect(sent[0][2]).toBe(0); expect(sent[0][4]).toEqual([9]);
  expect((t as any).inflight.has("0xcancel")).toBe(true);
});

test("cancel-only calldata has no zero-size placement and legacy maker fees normalize to rebates", async () => {
  const { Market } = await import("../src/market");
  const { PARAMS, obIface } = await import("./helpers");
  config.makerFeeBpsOverride = undefined;
  const m = new Market();
  m.params = { ...PARAMS, makerFeeBps: PARAMS.tickSize.div(10) };
  expect(m.makerFeeBps).toBe(-10);
  const d = obIface.decodeFunctionData("batchUpdate", m.encode("buy", 0, .0236, [9]));
  for (let i = 0; i < 4; i++) expect(d[i].length).toBe(0);
  expect(Number(d[4][0])).toBe(9);
});
