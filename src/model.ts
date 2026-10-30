import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import { RULEBOOK } from "./rulebook";

/** Models forecast buy/sell each block; execution can hold when costs or risk fail. */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "MON-USDC";
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
  portfolio?: { inventoryMon: number; entryPrice: number | null; pendingBuyMon: number; pendingSellMon: number; freeMon: number; freeUsdc: number; netPnlUsd: number; maxPositionMon: number };
  execution?: { inferenceUsd?: number; volatilityBps: number; makerFeeBps: number; exitCostBps: number; gasUsd: number; quoteAgeBlocks: number; rulebook: string };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      rulebook: JSON.stringify(RULEBOOK),
      question: "Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Make markets on MON-USDC on Kuru. Blocks are ~300 ms; `horizonBlocks` (~30 s) is the horizon. Every block you pick a side for a post-only limit order just inside the touch. An existing order may stay when its side, remaining size and price still fit; otherwise it is cancelled and replaced. It never crosses. One fill captures only the distance to mid; full spread capture requires a successful round trip. The cost is adverse selection: a taker fills us exactly when the market is about to run the other way. Pick the side whose inventory you want to be holding `horizonBlocks` from now.",
      timing: "The order rests on the book from the next block until it is replaced, cancelled or filled. It fills only when a taker crosses it: a bid is filled by a taker sell, an ask by a taker buy. Most blocks do not fill.",
      inputs: "Treat taker flow as a candidate signal to validate: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book, and therefore who would hit us. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. A wide `spreadBps` means more edge per fill. Portfolio and execution describe inventory and costs. A blocked side is skipped by the execution gate; it is never automatically reversed.",
    },
    criteria: {
      buy: "Post a bid: mid more likely to be higher after `horizonBlocks` blocks. A fill here leaves us long MON, bought below mid.",
      sell: "Post an ask: mid more likely to be lower after `horizonBlocks` blocks. A fill here leaves us short MON, sold above mid.",
    },
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  /** Uniform in [-1.5, 1.5), fixed per block. 32-bit hash: `^` yields a signed int, so finish with `>>> 0`. */
  private noise(block: number) {
    let h = Math.imul(block, 2654435761) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 2246822519) >>> 0; h = (h ^ (h >>> 13)) >>> 0;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

/**
 * Jev needs TYPESAFE_AI_API_KEY. Without one every call fails, so every block is a late hold and
 * the dashboard shows nothing happening. Run the mock instead: the snapshot names it, so the
 * dashboard labels it as a stand-in rather than passing it off as Jev.
 */
export const createModel = (): Model => {
  if (config.model !== "jev") return new MockModel();
  if (!process.env.TYPESAFE_AI_API_KEY?.trim()) {
    console.warn("MODEL=jev but TYPESAFE_AI_API_KEY is not set: running the mock model instead");
    return new MockModel();
  }
  return new JevModel();
};
