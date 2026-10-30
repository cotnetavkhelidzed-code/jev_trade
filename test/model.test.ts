import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { config } from "../src/config";
import { JevModel, MockModel, createModel, type TradeState } from "../src/model";
import { isolateConfig } from "./helpers";

isolateConfig();

const state = (o: Partial<TradeState> & { cvd?: [number, number] } = {}): TradeState => {
  const [buyMon, sellMon] = o.cvd ?? [0, 0];
  return {
    market: "MON-USDC", block: o.block ?? 117_000_100, horizonBlocks: 100, blockMs: 300, mid: 0.0236, spreadBps: 2.5,
    bookImbalance: o.bookImbalance ?? 0,
    depth: { "10bps": { bid: 1000, ask: 900 }, "25bps": { bid: 3000, ask: 2500 }, "50bps": { bid: 6000, ask: 5000 } },
    book: { bids: ["0.023598 x 2299"], asks: ["0.023604 x 819"] },
    returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0, ...o.returnsBps },
    recentMids: "0.023600 0.023601",
    trades: { count: buyMon || sellMon ? 2 : 0, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: null, lastPrice: null, lastSide: null },
    recentTrades: [],
    allowed: { buy: true, sell: true },
  };
};

describe("MockModel", () => {
  const sleep = spyOn(Bun, "sleep");
  beforeEach(() => sleep.mockResolvedValue(undefined as any));
  afterAll(() => sleep.mockRestore());
  const model = new MockModel();

  test("named 'mock' so the dashboard labels it a stand-in", () => {
    expect(model.name).toBe("mock");
  });

  test("answers buy or sell (never hold) with probabilities that sum to 1", async () => {
    for (let b = 0; b < 300; b++) {
      const d = await model.decide(state({ block: b }));
      expect(["buy", "sell"]).toContain(d.action);
      expect(d.probabilities.hold).toBe(0);
      expect(d.probabilities.buy + d.probabilities.sell).toBeCloseTo(1, 12);
      expect(d.upIn10).toBe(d.probabilities.buy);
      expect(d.action).toBe(d.probabilities.buy >= 0.5 ? "buy" : "sell");
    }
  });

  test("is deterministic per block and trades both ways on a flat market", async () => {
    const a = await model.decide(state({ block: 42 })), b = await model.decide(state({ block: 42 }));
    expect(a.probabilities).toEqual(b.probabilities);
    const actions = new Set<string>();
    for (let blk = 0; blk < 100; blk++) actions.add((await model.decide(state({ block: blk }))).action);
    expect(actions).toEqual(new Set(["buy", "sell"]));
  });

  test("leans with momentum, book imbalance and taker flow", async () => {
    const up = await model.decide(state({ returnsBps: { last1: 0, last5: 0, last20: 80, last100: 0 } }));
    const down = await model.decide(state({ returnsBps: { last1: 0, last5: 0, last20: -80, last100: 0 } }));
    expect(up.probabilities.buy).toBeGreaterThan(0.99);
    expect(down.probabilities.buy).toBeLessThan(0.01);
    const bidHeavy = await model.decide(state({ bookImbalance: 1 })), askHeavy = await model.decide(state({ bookImbalance: -1 }));
    expect(bidHeavy.probabilities.buy).toBeGreaterThan(askHeavy.probabilities.buy);
    const buyers = await model.decide(state({ cvd: [900, 100] })), sellers = await model.decide(state({ cvd: [100, 900] }));
    expect(buyers.probabilities.buy).toBeGreaterThan(sellers.probabilities.buy);
  });

  test("no taker volume is a zero flow signal, not NaN", async () => {
    const d = await model.decide(state({ cvd: [0, 0] }));
    expect(Number.isFinite(d.probabilities.buy)).toBe(true);
  });

  // Regression: `h ^= h >>> 13` yielded a signed int32, so for half of all blocks the noise landed in
  // (-4.5, -1.5]: mean -1.5 instead of 0, and the stand-in bought only 25% of the time on a flat market.
  test("noise is bounded to +-1.5", () => {
    for (let b = 117_000_000; b < 117_005_000; b++) {
      const n = (model as any).noise(b);
      expect(n).toBeGreaterThanOrEqual(-1.5);
      expect(n).toBeLessThan(1.5);
    }
  });

  test("on a flat market it buys about half the time", async () => {
    let buys = 0;
    const N = 4000;
    for (let b = 117_000_000; b < 117_000_000 + N; b++) if ((await model.decide(state({ block: b }))).action === "buy") buys++;
    expect(buys / N).toBeGreaterThan(0.4);
    expect(buys / N).toBeLessThan(0.6);
  });

  test("noise is deterministic and centred on zero", () => {
    let sum = 0;
    for (let b = 117_000_000; b < 117_020_000; b++) {
      expect((model as any).noise(b)).toBe((model as any).noise(b));
      sum += (model as any).noise(b);
    }
    expect(Math.abs(sum / 20_000)).toBeLessThan(0.05);
  });

  test("stands in for inference time with an 80 ms sleep, and counts ~4 chars per token", async () => {
    sleep.mockClear();
    const s = state();
    const d = await model.decide(s);
    expect(sleep).toHaveBeenCalledWith(80);
    expect(d.inputTokens).toBe(Math.round(JSON.stringify(s).length / 4));
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("really takes about 80 ms without the stub", async () => {
    sleep.mockRestore();
    const d = await new MockModel().decide(state());
    expect(d.latencyMs).toBeGreaterThanOrEqual(79);
    spyOn(Bun, "sleep");
  });
});

describe("JevModel (real AI SDK + TypeSafe provider, HTTP answered locally)", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  let requests: { url: string; headers: Headers; body: any }[] = [];
  let reply: () => Response;
  beforeEach(() => {
    process.env.TYPESAFE_AI_API_KEY = "test-key";
    requests = [];
    fetchSpy.mockImplementation((async (url: any, init: any) => {
      requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return reply();
    }) as any);
  });
  afterEach(() => { delete process.env.TYPESAFE_AI_API_KEY; });
  afterAll(() => fetchSpy.mockRestore());
  const ok = (answer: object, usage: object | null = { input_tokens: 812, output_tokens: 0 }) => () =>
    Response.json({ model: "jev-latest", answers: { direction: { type: "choice", ...answer } }, ...(usage ? { usage } : {}) });

  test("sends the state and one buy/sell choice question to /systemone with the API key", async () => {
    reply = ok({ choice: "sell", probabilities: { buy: 0.27, sell: 0.73 } });
    config.jevModelId = "jev-latest";
    const s = state();
    const d = await new JevModel().decide(s);
    expect(requests.length).toBe(1);
    const r = requests[0]!;
    expect(r.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(r.headers.get("authorization")).toBe("Bearer test-key");
    expect(r.body.model).toBe("jev-latest");
    expect(r.body.state).toEqual(s);
    expect(Object.keys(r.body.questions)).toEqual(["direction"]);
    const q = r.body.questions.direction;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual(["buy", "sell"]); // Jev makes the buy/sell call; there is no hold option
    expect(q.instructions.question).toContain("horizonBlocks");
    expect(d).toMatchObject({ action: "sell", probabilities: { buy: 0.27, sell: 0.73, hold: 0 }, upIn10: 0.27, inputTokens: 812 });
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("uses JEV_MODEL_ID as its name and model", async () => {
    config.jevModelId = "jev-2026-10";
    reply = ok({ choice: "buy", probabilities: { buy: 0.6, sell: 0.4 } });
    const m = new JevModel();
    expect(m.name).toBe("jev-2026-10");
    await m.decide(state());
    expect(requests[0]!.body.model).toBe("jev-2026-10");
  });

  test("missing usage counts zero tokens", async () => {
    reply = ok({ choice: "buy", probabilities: { buy: 0.55, sell: 0.45 } }, null);
    const d = await new JevModel().decide(state());
    expect(d.inputTokens).toBe(0);
    expect(d.probabilities).toEqual({ buy: 0.55, sell: 0.45, hold: 0 });
  });

  test("the AI SDK rejects an incomplete distribution before the bot sees it (so the ?? 0 fallbacks never fire)", async () => {
    reply = ok({ choice: "buy", probabilities: { buy: 1 } });
    expect(new JevModel().decide(state())).rejects.toThrow("complete distribution");
  });

  test("an API error rejects after exactly one attempt (no retries: a retry would miss the block)", async () => {
    reply = () => Response.json({ message: "overloaded" }, { status: 503 });
    expect(new JevModel().decide(state())).rejects.toThrow("overloaded");
    await Bun.sleep(0);
    expect(requests.length).toBe(1);
  });
});

describe("createModel", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  afterAll(() => warn.mockRestore());
  afterEach(() => { delete process.env.TYPESAFE_AI_API_KEY; warn.mockClear(); });

  test("MODEL=mock (the default) is the mock", () => {
    config.model = "mock";
    expect(createModel()).toBeInstanceOf(MockModel);
  });

  test("MODEL=jev without an API key falls back to the mock, loudly", () => {
    config.model = "jev";
    delete process.env.TYPESAFE_AI_API_KEY;
    expect(createModel()).toBeInstanceOf(MockModel);
    process.env.TYPESAFE_AI_API_KEY = "   ";
    expect(createModel()).toBeInstanceOf(MockModel);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain("TYPESAFE_AI_API_KEY is not set");
  });

  test("MODEL=jev with a key is Jev", () => {
    config.model = "jev";
    config.jevModelId = "jev-latest";
    process.env.TYPESAFE_AI_API_KEY = "k";
    const m = createModel();
    expect(m).toBeInstanceOf(JevModel);
    expect(m.name).toBe("jev-latest");
    expect(warn).not.toHaveBeenCalled();
  });
});
