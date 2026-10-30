/** One real inference on a fixed synthetic snapshot. Checks API access, not trading performance. */
import { config } from "../src/config";
import { JevModel, type TradeState } from "../src/model";

if (!process.env.TYPESAFE_AI_API_KEY?.trim()) throw new Error("TYPESAFE_AI_API_KEY is required");

const state: TradeState = {
  market: "MON-USDC", block: 1, horizonBlocks: config.horizonBlocks, blockMs: 300,
  mid: 0.02, spreadBps: 1, bookImbalance: 0,
  depth: { "10bps": { bid: 1000, ask: 1000 } },
  book: { bids: ["0.019999 x 1000"], asks: ["0.020001 x 1000"] },
  returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0 },
  recentMids: "0.020000 0.020000", recentTrades: [],
  trades: { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null },
  allowed: { buy: true, sell: true },
};

try {
  const decision = await Promise.race([
    new JevModel().decide(state),
    Bun.sleep(30_000).then(() => { throw new Error("VerificationTimeout"); }),
  ]);
  const valid = ["buy", "sell"].includes(decision.action)
    && [decision.probabilities.buy, decision.probabilities.sell].every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(decision.probabilities.buy + decision.probabilities.sell - 1) < 0.001;
  console.log(JSON.stringify({ ok: valid, source: "synthetic API check", model: config.jevModelId, decision }, null, 2));
  process.exit(valid ? 0 : 1);
} catch (error) {
  // Provider errors can contain request headers. Print only safe diagnostic fields.
  const e = error as { name?: string; statusCode?: number; message?: string };
  console.error(JSON.stringify({ ok: false, source: "synthetic API check", model: config.jevModelId,
    error: e.message === "VerificationTimeout" ? "timeout" : e.name, statusCode: e.statusCode ?? null }));
  process.exit(1);
}
