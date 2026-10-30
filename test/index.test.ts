/**
 * End to end: the real entry point (src/index.ts) against the practice exchange.
 *
 * 1. In-process, live mode with a throwaway key: signs and sends every block, receipts, maker fills.
 *    Config is pinned for the whole run (the running bot reads it on every call), and every interval the
 *    bot starts is cleared before the assertions, so it can never fall back to a real RPC.
 * 2. A real `bun run src/index.ts` subprocess in dry-run mode with WebSocket heads, read over SSE the
 *    way the dashboard reads it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import { config } from "../src/config";
import type { BlockEvent } from "../src/trader";
import { startPracticeExchange, type PracticeExchange } from "../scripts/practice-exchange";
import { until } from "./helpers";

type Msg = { event: string; data: any };

/** Read an SSE stream into `got` until aborted. */
function subscribe(url: string) {
  const ac = new AbortController();
  const got: Msg[] = [];
  fetch(url, { signal: ac.signal }).then(async (r) => {
    const reader = r.body!.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        got.push({ event: /^event: (.*)$/m.exec(chunk)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!) });
      }
    }
  }).catch(() => {});
  return { got, close: () => ac.abort() };
}

/** The dashboard's rule (web/src/lib/useFeed.ts): a fill or quote for a block it has not received is dropped. */
function dashboardView(msgs: Msg[]) {
  const seen = new Set<number>();
  let shownFills = 0, droppedFills = 0;
  for (const m of msgs) {
    if (m.event === "snapshot") for (const e of m.data.history as BlockEvent[]) seen.add(e.block);
    if (m.event === "block") seen.add(m.data.block);
    if (m.event === "fill") seen.has(m.data.block) ? shownFills++ : droppedFills++;
  }
  return { shownFills, droppedFills };
}

// ------------------------------------------------------------------------------------------------

describe("live mode, in process", () => {
  let ex: PracticeExchange;
  let srv: ReturnType<typeof Bun.serve>;
  let address = "";
  const saved = { ...config };
  const cwd = process.cwd();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const lines: string[] = [];
  let sse: ReturnType<typeof subscribe>;

  beforeAll(async () => {
    ex = startPracticeExchange({ blockMs: 300, seed: 31, takersPerBlock: 2, volBps: 1.5 });
    const key = ethers.Wallet.createRandom().privateKey;
    address = new ethers.Wallet(key).address;
    ex.setMargin(address, 600, 20); // pre-funded: no startup deposits
    Object.assign(config, { rpcUrl: ex.url, readRpcUrl: ex.url, wsUrl: undefined, privateKey: key, dryRun: false, model: "mock", port: 3999, gasLimit: undefined });

    const realServe = Bun.serve, realInterval = globalThis.setInterval;
    const serve = spyOn(Bun, "serve").mockImplementation(((o: any) => (srv = realServe({ ...o, port: 0 }))) as any);
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: number) => { const h = realInterval(fn, ms); intervals.push(h); return h; }) as any);
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    const warn = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    process.chdir(mkdtempSync(join(tmpdir(), "jev-e2e-"))); // the bot appends to ./data/events.jsonl for as long as it runs
    try {
      await import("../src/index.ts");
    } finally {
      serve.mockRestore();
      interval.mockRestore();
    }
    sse = subscribe(`http://localhost:${srv!.port}/events`);
    await Bun.sleep(6000); // ~20 blocks
    for (const h of intervals) clearInterval(h); // stop the block feed and the SSE ping
    await Bun.sleep(400); // let the last loop, receipts and log polls land
    sse.close();
    log.mockRestore();
    warn.mockRestore();
  }, 30_000);

  afterAll(() => {
    srv?.stop(true);
    ex?.stop();
    Object.assign(config, saved);
    process.chdir(cwd);
  });

  const blocks = () => sse.got.filter((m) => m.event === "block").map((m) => m.data as BlockEvent);

  test("snapshot names the stand-in model, the wallet and live mode", () => {
    expect(sse.got[0]!.event).toBe("snapshot");
    expect(sse.got[0]!.data).toMatchObject({ model: "mock", wallet: address, dryRun: false, market: config.market });
    expect(typeof sse.got[0]!.data.startedAt).toBe("number");
  });

  test("one decision every block, and every block has a real order on Kuru's book: a new one, or the one already there", () => {
    const bs = blocks();
    expect(bs.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < bs.length; i++) expect(bs[i]!.block).toBe(bs[i - 1]!.block + 1); // no block skipped
    const decided = bs.filter((e) => !e.decision!.late);
    expect(decided.length).toBe(bs.length); // the mock answers in ~80 ms, well inside 300 ms
    for (const e of decided) {
      expect(["buy", "sell"]).toContain(e.decision!.action);
      expect(e.quote!.txHash).toMatch(/^0x[0-9a-f]{64}$/); // kept: the tx that placed it
      expect(["sent", "resting"]).toContain(e.quote!.status);
      if (e.quote!.status === "resting") expect(e.quote!.gasMon).toBe(0);
    }
    const sent = decided.filter((e) => e.quote!.status === "sent").length;
    expect(sent).toBeLessThan(decided.length); // some blocks kept their order and paid nothing
    expect(bs.at(-1)!.totals).toMatchObject({ quotes: sent, kept: decided.length - sent });
    const s = ex.stats(address);
    expect(s.placed + s.reverted).toBeGreaterThanOrEqual(sent - 2); // the last one or two may still be in the mempool
  });

  test("receipts come back as quote events: placed with an order id (or reverted), real gas", () => {
    const quotes = sse.got.filter((m) => m.event === "quote").map((m) => m.data.quote);
    const sent = blocks().filter((e) => e.quote?.status === "sent").length; // kept blocks send nothing, so get no receipt
    expect(quotes.length).toBeGreaterThanOrEqual(sent - 2);
    expect(quotes.filter((q) => q.status === "placed").every((q) => Number.isInteger(q.orderId) && q.gasMon > 0)).toBe(true);
    expect(quotes.filter((q) => q.status === "placed").length).toBeGreaterThan(quotes.length / 2);
  });

  test("maker fills come from the chain's Trade logs, with the taker's tx", () => {
    const fills = sse.got.filter((m) => m.event === "fill").map((m) => m.data.fill);
    expect(ex.stats(address).fills).toBeGreaterThan(0);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => !f.simulated && /^0x[0-9a-f]{64}$/.test(f.txHash))).toBe(true);
    // fills after the last emitted block (the bot was stopped mid-flow) are not in its totals yet
    expect(blocks().at(-1)!.totals.fills).toBeGreaterThan(0);
    expect(blocks().at(-1)!.totals.fills).toBeLessThanOrEqual(ex.stats(address).fills);
  });

  test("every emitted block was also written to ./data/events.jsonl", async () => {
    const logged = (await Bun.file("data/events.jsonl").text()).trim().split("\n").map((l) => JSON.parse(l).block);
    expect(logged.slice(-blocks().length)).toEqual(blocks().map((e) => e.block));
  });

  test("console: a startup line, one line per decided block, one per fill", () => {
    expect(lines.some((l) => l.startsWith(`jev-trader · model=mock · post-only 1 tick inside the touch · horizon 100 blocks · wallet ${address}`))).toBe(true);
    const blockLines = lines.filter((l) => /^#\d+ \d\.\d{6} b\d+ s\d+ \d+ms (BUY|SELL) 200 @ \d\.\d{6}( capped)?( kept| cancel \d+ 0x[0-9a-f]{64}) pnl \$-?[\d.]+ · read \d+ms loop \d+ms$/.test(l));
    expect(blockLines.length).toBe(blocks().length);
    expect(lines.filter((l) => /^#\d+ FILL (buy|sell) [\d.]+ @ \d\.\d{6} order \d+ 0x[0-9a-f]{64}$/.test(l)).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------

describe("dry run, real process, WebSocket heads", () => {
  let ex: PracticeExchange;
  let proc: ReturnType<typeof Bun.spawn>;
  let sse: ReturnType<typeof subscribe>;
  let history: BlockEvent[] = [];
  let snapshot: any;
  let stdout = "";

  beforeAll(async () => {
    ex = startPracticeExchange({ blockMs: 300, seed: 32, takersPerBlock: 2, volBps: 1.5 });
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PRIVATE_KEY", "TYPESAFE_AI_API_KEY", "MODEL"].includes(k)) env[k] = v;
    proc = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/index.ts")], {
      cwd: mkdtempSync(join(tmpdir(), "jev-e2e-dry-")),
      env: { ...env, RPC_URL: ex.url, READ_RPC_URL: ex.url, WS_URL: ex.wsUrl, DRY_RUN: "true", MODEL: "mock", PORT: String(port) },
      stdout: "pipe", stderr: "pipe",
    });
    (async () => { for await (const c of proc.stdout as ReadableStream<Uint8Array>) stdout += new TextDecoder().decode(c); })();
    const base = `http://localhost:${port}`;
    await until(() => stdout.includes("jev-trader ·"), 15_000, "bot startup");
    await Bun.sleep(300);
    sse = subscribe(`${base}/events`);
    await Bun.sleep(9000); // ~30 blocks
    sse.close();
    history = await (await fetch(`${base}/history`)).json();
    snapshot = await (await fetch(base)).json();
    proc.kill();
    await proc.exited;
  }, 40_000);

  afterAll(() => { proc?.kill(); ex?.stop(); });

  test("no wallet, stand-in model, every block decided and quoted as a simulation", () => {
    expect(snapshot).toMatchObject({ model: "mock", wallet: null, dryRun: true });
    const bs = sse.got.filter((m) => m.event === "block").map((m) => m.data as BlockEvent);
    expect(bs.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < bs.length; i++) expect(bs[i]!.block).toBe(bs[i - 1]!.block + 1);
    expect(bs.every((e) => (e.quote?.status === "sim" || e.quote?.status === "resting") && e.quote.txHash === null)).toBe(true);
    expect(bs.some((e) => e.quote?.status === "resting")).toBe(true);
    expect(ex.requests.get("eth_sendRawTransaction") ?? 0).toBe(0);
    expect(stdout).toContain("DRY RUN");
  });

  test("simulated fills happen against real prints", () => {
    const fills = sse.got.filter((m) => m.event === "fill").map((m) => m.data.fill);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => f.simulated && f.txHash === null)).toBe(true);
    expect(history.at(-1)!.totals.fills).toBeGreaterThanOrEqual(fills.length);
  });

  // Regression: fills for the block still being decided used to be broadcast before that block, so the
  // dashboard dropped them (13 of 13 in a 9 s run) and /history never had them.
  test("every fill reaches the dashboard, on its block", () => {
    const v = dashboardView(sse.got);
    process.stderr.write(`  dry run: ${v.shownFills + v.droppedFills} fill events, ${v.droppedFills} dropped by the dashboard rule, ${history.filter((e) => e.fill).length} blocks with a fill in /history, totals.fills ${history.at(-1)!.totals.fills}\n`);
    expect(v.shownFills).toBeGreaterThan(0);
    expect(v.droppedFills).toBe(0);
    expect(history.filter((e) => e.fill).length).toBeGreaterThan(0);
    // Usually the fill rides on its block event (the log poll beats the model); when the poll is slower it
    // comes as its own fill event for a block the page already has. Either way it is shown.
    const blocksWithFill = sse.got.filter((m) => m.event === "block" && m.data.fill).length;
    expect(blocksWithFill).toBeLessThanOrEqual(v.shownFills);
  });
});
