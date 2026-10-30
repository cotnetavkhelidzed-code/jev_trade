import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { config } from "../src/config";
import { startServer } from "../src/server";
import type { BlockEvent } from "../src/trader";
import type { Fill, Quote } from "../src/market";
import { isolateConfig, until } from "./helpers";

isolateConfig();

const meta = { model: "mock", wallet: null, dryRun: true, market: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394", startedAt: 1_793_000_000_000 };
const ev = (block: number): BlockEvent => ({
  block, ts: 1, mid: 0.0236, bestBid: 0.02359, bestAsk: 0.02361, spreadBps: 8.47,
  decision: { action: "buy", probabilities: { buy: 0.7, sell: 0.3, hold: 0 }, upIn10: 0.7, latencyMs: 81, late: false },
  quote: null, fill: null, resting: { bidMon: 200, askMon: 0 },
  position: { side: "flat", size: 0, entryPrice: null, unrealizedUsd: 0, unrealizedMon: 0 },
  totals: { blocks: 1, decisions: 1, quotes: 1, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 },
});

let history: BlockEvent[] = [];
let base = "";
let ping: () => void = () => {};
let srv: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof startServer>;

beforeAll(() => {
  config.port = 4321;
  const realServe = Bun.serve;
  const serve = spyOn(Bun, "serve").mockImplementation(((opts: any) => {
    expect(opts.port).toBe(4321); // listens on PORT
    return (srv = realServe({ ...opts, port: 0 }));
  }) as any);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    expect(ms).toBe(15_000);
    ping = fn;
    return 0 as any;
  }) as any);
  api = startServer(meta, () => history);
  serve.mockRestore();
  interval.mockRestore();
  base = `http://localhost:${srv.port}`;
});
afterAll(() => srv.stop(true));

/** Open /events and collect parsed SSE messages until aborted. */
function subscribe() {
  const ac = new AbortController();
  const got: { event: string; data: any }[] = [];
  let buf = "";
  const res = fetch(`${base}/events`, { signal: ac.signal });
  res.then(async (r) => {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(chunk)![1]!, data = JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!);
          got.push({ event, data });
        }
      }
    } catch {}
  }).catch(() => {});
  return { got, res, close: () => ac.abort() };
}

describe("HTTP", () => {
  test("GET / is the snapshot: meta plus the latest block (null before the first)", async () => {
    history = [];
    const r = await fetch(`${base}/`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ ...meta, latest: null });
    history = [ev(1), ev(2)];
    expect((await (await fetch(base)).json()).latest.block).toBe(2);
  });

  test("GET /history is every kept block", async () => {
    history = [ev(1), ev(2), ev(3)];
    expect((await (await fetch(`${base}/history`)).json()).map((e: BlockEvent) => e.block)).toEqual([1, 2, 3]);
  });

  test("CORS preflight and 404", async () => {
    const pre = await fetch(`${base}/history`, { method: "OPTIONS" });
    expect(pre.status).toBe(200);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toBe("*");
    expect(await pre.text()).toBe("");
    const nf = await fetch(`${base}/nope`);
    expect(nf.status).toBe(404);
    expect(nf.headers.get("access-control-allow-origin")).toBe("*");
    expect(await nf.json()).toEqual({ error: "not found" });
  });
});

describe("SSE /events", () => {
  test("snapshot on connect, then block, quote and fill events, and pings, to every client", async () => {
    history = [ev(7)];
    const a = subscribe(), b = subscribe();
    await until(() => a.got.length === 1 && b.got.length === 1, 3000, "snapshots");
    const r = await a.res;
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(a.got[0]).toEqual({ event: "snapshot", data: { ...meta, history: [ev(7)] } });

    const quote: Quote = { side: "buy", price: 0.023601, size: 200, txHash: "0xabc", gasMon: 0.0436, cancel: [5], status: "placed", orderId: 6, capped: false };
    const fill: Fill = { side: "buy", size: 200, price: 0.023601, txHash: "0xdef", orderId: 6, simulated: false };
    api.broadcast(ev(8));
    api.broadcastQuote(8, quote);
    api.broadcastFill(9, fill);
    ping();
    await until(() => a.got.length === 5 && b.got.length === 5, 3000, "broadcasts");
    for (const c of [a, b]) {
      expect(c.got.slice(1).map((m) => m.event)).toEqual(["block", "quote", "fill", "ping"]);
      expect(c.got[1]!.data).toEqual(ev(8));
      expect(c.got[2]!.data).toEqual({ block: 8, quote });
      expect(c.got[3]!.data).toEqual({ block: 9, fill });
      expect(typeof c.got[4]!.data).toBe("number");
    }
    a.close(); b.close();
  });

  test("a client that went away is dropped; the others keep streaming", async () => {
    history = [];
    const gone = subscribe(), stay = subscribe();
    await until(() => gone.got.length === 1 && stay.got.length === 1, 3000, "snapshots");
    gone.close();
    await Bun.sleep(20);
    for (let i = 0; i < 3; i++) { api.broadcast(ev(100 + i)); await Bun.sleep(5); }
    await until(() => stay.got.length === 4, 3000, "stay");
    expect(gone.got.length).toBe(1);
    stay.close();
  });

  // Regression: ReadableStream calls cancel(reason), not cancel(controller), so the hook used to
  // delete the reason and leave the dead client until the next send failed on it.
  test("cancel removes the disconnected client's controller", async () => {
    const deleted: unknown[] = [];
    const realDelete = Set.prototype.delete;
    Set.prototype.delete = function (v: unknown) { deleted.push(v); return realDelete.call(this, v); };
    try {
      const c = subscribe();
      await until(() => c.got.length === 1, 3000, "snapshot");
      c.close();
      await Bun.sleep(50);
      expect(deleted.some((v) => v && typeof v === "object" && "enqueue" in (v as object))).toBe(true);
    } finally {
      Set.prototype.delete = realDelete;
    }
  });
});
