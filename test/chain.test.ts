import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { config } from "../src/config";
import { rpc, startBlockFeed } from "../src/chain";
import { flush, isolateConfig } from "./helpers";

isolateConfig();

/** fetch stand-in that answers eth_blockNumber with whatever `head` is (or fails on demand). */
let head = 0;
let fail: "reject" | "rpc-error" | null = null;
const fetchSpy = spyOn(globalThis, "fetch");
const posted: { url: string; body: any }[] = [];
beforeEach(() => {
  head = 0; fail = null; posted.length = 0;
  fetchSpy.mockImplementation((async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    posted.push({ url: String(url), body });
    if (fail === "reject") throw new Error("socket hang up");
    return { json: async () => (fail === "rpc-error" ? { error: { code: -32007, message: "rate limited" } } : { result: "0x" + head.toString(16) }) };
  }) as any);
});
afterAll(() => fetchSpy.mockRestore());

describe("rpc", () => {
  test("posts a JSON-RPC 2.0 request to the send RPC by default and returns the result", async () => {
    config.rpcUrl = "http://send.example";
    head = 0x2a;
    expect(await rpc<string>("eth_blockNumber")).toBe("0x2a");
    expect(posted).toEqual([{ url: "http://send.example", body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] } }]);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  test("uses the URL it is given and passes params through", async () => {
    await rpc("eth_getBalance", ["0xabc", "latest"], "http://read.example");
    expect(posted[0]).toEqual({ url: "http://read.example", body: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xabc", "latest"] } });
  });

  test("throws a JSON-RPC error as 'method: message (code)'", async () => {
    fail = "rpc-error";
    expect(rpc("eth_blockNumber")).rejects.toThrow("eth_blockNumber: rate limited (-32007)");
  });

  test("propagates transport failures", async () => {
    fail = "reject";
    expect(rpc("eth_blockNumber")).rejects.toThrow("socket hang up");
  });
});

// ------------------------------------------------------------------------------------------------

class FakeWS {
  static all: FakeWS[] = [];
  sent: string[] = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.closed++; this.onclose?.(); }
  head(n: number) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0x1", result: { number: "0x" + n.toString(16) } } }) }); }
}
const RealWS = globalThis.WebSocket;

describe("startBlockFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeWS.all = [];
    (globalThis as any).WebSocket = FakeWS;
    config.readRpcUrl = "http://read.example";
    config.wsUrl = undefined;
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    (globalThis as any).WebSocket = RealWS;
  });
  // Bun 1.3.14: advanceTimersByTime(0) then (149) fires a 150 ms interval early, so a "0" step is 1 ms (what setTimeout(fn, 0) really waits).
  const step = async (ms: number) => { await flush(); jest.advanceTimersByTime(Math.max(1, ms)); await flush(); };

  test("polls eth_blockNumber on the read RPC right away and every pollMs", async () => {
    const seen: number[] = [];
    head = 100;
    startBlockFeed((b) => seen.push(b), 150);
    await step(0);
    expect(seen).toEqual([100]);
    expect(posted.every((p) => p.url === "http://read.example" && p.body.method === "eth_blockNumber")).toBe(true);
    head = 101;
    await step(150);
    await step(0);
    expect(seen).toEqual([100, 101]);
    expect(posted.length).toBe(2);
  });

  test("the default poll interval is 150 ms", async () => {
    startBlockFeed(() => {});
    await step(0); // t = 1
    const n = posted.length;
    await step(148); // t = 149
    expect(posted.length).toBe(n);
    await step(1); // t = 150
    expect(posted.length).toBe(n + 1);
  });

  test("never emits the same block twice or an older block", async () => {
    const seen: number[] = [];
    head = 100;
    startBlockFeed((b) => seen.push(b), 150);
    await step(0);
    await step(150); await step(0); // still 100
    head = 99;
    await step(150); await step(0); // went backwards (another RPC node behind)
    expect(seen).toEqual([100]);
  });

  test("swallows polling failures and keeps going", async () => {
    const seen: number[] = [];
    fail = "reject";
    startBlockFeed((b) => seen.push(b), 150);
    await step(0);
    fail = "rpc-error";
    await step(150); await step(0);
    expect(seen).toEqual([]);
    fail = null; head = 7;
    await step(150); await step(0);
    expect(seen).toEqual([7]);
  });

  test("without WS_URL no socket is opened", async () => {
    startBlockFeed(() => {}, 150);
    await step(0);
    expect(FakeWS.all).toEqual([]);
  });

  test("subscribes to newHeads and emits each head", async () => {
    config.wsUrl = "ws://heads.example";
    const seen: number[] = [];
    startBlockFeed((b) => seen.push(b), 1e9);
    await step(0);
    const ws = FakeWS.all[0]!;
    expect(ws.url).toBe("ws://heads.example");
    ws.onopen!();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] });
    ws.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xsub" }) }); // subscription ack: not a head
    ws.head(500);
    await step(0);
    expect(seen).toEqual([500]);
  });

  test("a burst of heads in one tick runs the loop once, for the newest block", async () => {
    config.wsUrl = "ws://heads.example";
    const seen: number[] = [];
    startBlockFeed((b) => seen.push(b), 1e9);
    await step(0);
    const ws = FakeWS.all[0]!;
    ws.head(10); ws.head(11); ws.head(12);
    await step(0);
    expect(seen).toEqual([12]);
    ws.head(11); // stale after 12
    ws.head(13);
    await step(0);
    expect(seen).toEqual([12, 13]);
  });

  test("WebSocket and polling feed the same de-duplicated stream", async () => {
    config.wsUrl = "ws://heads.example";
    const seen: number[] = [];
    head = 20;
    startBlockFeed((b) => seen.push(b), 150);
    await step(0);
    FakeWS.all[0]!.head(20); // same block from the socket
    FakeWS.all[0]!.head(21);
    await step(0);
    await step(150); await step(0); // poll still says 20
    expect(seen).toEqual([20, 21]);
  });

  test("reconnects after a close, backing off 1 s per attempt up to 10 s", async () => {
    config.wsUrl = "ws://heads.example";
    startBlockFeed(() => {}, 1e9);
    await step(0);
    expect(FakeWS.all.length).toBe(1);
    const expected = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 10000, 10000];
    for (const [i, delay] of expected.entries()) {
      FakeWS.all.at(-1)!.close();
      await step(delay - 2);
      expect(FakeWS.all.length).toBe(i + 1); // not yet
      await step(2);
      expect(FakeWS.all.length).toBe(i + 2);
    }
  });

  test("an error closes the socket, which reconnects", async () => {
    config.wsUrl = "ws://heads.example";
    startBlockFeed(() => {}, 1e9);
    await step(0);
    const ws = FakeWS.all[0]!;
    ws.onerror!();
    expect(ws.closed).toBe(1);
    await step(1000);
    expect(FakeWS.all.length).toBe(2);
  });
});
