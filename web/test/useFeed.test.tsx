import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import useFeedDefault, { useFeed, useUptime as reexportedUseUptime } from "../src/lib/useFeed";
import { useUptime } from "../src/lib/useUptime";
import type { FeedState } from "../src/lib/types";
import {
  BASE_BLOCK,
  FakeEventSource,
  STARTED_AT,
  WALLET,
  WEB,
  blocks,
  cleanup,
  decision,
  ev,
  fill,
  installEventSource,
  lateDecision,
  meta,
  quote,
  renderHook,
  run,
  uninstallEventSource,
} from "./helpers";

const API = "http://localhost:3000";

function mountFeed(url = API) {
  return renderHook((u: string) => useFeed(u), url);
}

const advance = (ms: number) => run(() => jest.advanceTimersByTime(ms));

describe.skipIf(!WEB)("lib/useFeed", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    installEventSource();
  });

  afterEach(() => {
    cleanup();
    uninstallEventSource();
    jest.useRealTimers();
  });

  test("exports: default and named hook, and useUptime re-export", () => {
    expect(useFeedDefault).toBe(useFeed);
    expect(reexportedUseUptime).toBe(useUptime);
  });

  describe("connection", () => {
    test("opens one EventSource on <api>/events, trailing slashes trimmed", () => {
      mountFeed("https://api.example.com///");
      expect(FakeEventSource.instances.length).toBe(1);
      expect(FakeEventSource.last.url).toBe("https://api.example.com/events");
    });

    test("an empty api url falls back to a relative /events", () => {
      mountFeed("");
      expect(FakeEventSource.last.url).toBe("/events");
    });

    test("initial state before anything arrives", () => {
      const h = mountFeed();
      const s: FeedState = h.current();
      expect(s).toEqual({
        meta: null,
        events: [],
        latest: null,
        connection: "connecting",
        avgLatencyMs: 0,
        latSum: 0,
        latCount: 0,
        early: { fills: {}, quotes: {} },
      } as FeedState);
    });

    test("onopen goes live", () => {
      const h = mountFeed();
      FakeEventSource.last.open();
      expect(h.current().connection).toBe("live");
    });

    test("does nothing without an EventSource implementation", () => {
      uninstallEventSource();
      delete (globalThis as { EventSource?: unknown }).EventSource;
      const h = mountFeed();
      advance(60_000);
      expect(h.current().connection).toBe("connecting");
      expect(FakeEventSource.instances.length).toBe(0);
      installEventSource();
    });

    test("a ping marks the stream live", () => {
      const h = mountFeed();
      expect(h.current().connection).toBe("connecting");
      FakeEventSource.last.emit("ping", Date.now());
      expect(h.current().connection).toBe("live");
    });

    test("a repeated connection state keeps the same state object", () => {
      const h = mountFeed();
      FakeEventSource.last.open();
      const state = h.current();
      FakeEventSource.last.emit("ping", 1);
      FakeEventSource.last.emit("ping", 2);
      expect(h.current()).toBe(state);
    });

    test("changing the api url closes the old stream and opens a new one", () => {
      const h = mountFeed("http://a");
      const first = FakeEventSource.last;
      h.rerender("http://b");
      expect(first.closed).toBe(true);
      expect(first.onopen).toBeNull();
      expect(first.onerror).toBeNull();
      expect(FakeEventSource.last.url).toBe("http://b/events");
      expect(FakeEventSource.instances.length).toBe(2);
    });
  });

  describe("snapshot", () => {
    test("sets meta, history, latest, live and the latency average", () => {
      const h = mountFeed();
      const history = blocks(4, BASE_BLOCK, (i) => ({ decision: decision("buy", 0.7, [80, 100, 0, 120][i]) }));
      history[2] = { ...history[2], decision: lateDecision() }; // late blocks do not count
      FakeEventSource.last.snapshot(meta(), history);
      const s = h.current();
      expect(s.meta).toEqual(meta());
      expect(s.events).toEqual(history);
      expect(s.latest).toEqual(history[3]);
      expect(s.connection).toBe("live");
      expect(s.avgLatencyMs).toBe(100); // (80 + 100 + 120) / 3
    });

    test("parses meta defensively", () => {
      const h = mountFeed();
      const now = Date.now();
      FakeEventSource.last.emit("snapshot", { model: 7, wallet: 0, dryRun: 1, market: null, startedAt: "x" });
      expect(h.current().meta).toEqual({ model: "", wallet: null, dryRun: true, market: "MON/USDC", startedAt: now });
      expect(h.current().events).toEqual([]);
      expect(h.current().latest).toBeNull();
    });

    test("a dry-run snapshot keeps wallet null and dryRun true", () => {
      const h = mountFeed();
      FakeEventSource.last.snapshot(meta({ model: "mock", wallet: null, dryRun: true }), []);
      expect(h.current().meta).toEqual(meta({ model: "mock", wallet: null, dryRun: true }));
    });

    test("a JSON null snapshot still yields default meta and an empty history", () => {
      const h = mountFeed();
      FakeEventSource.last.emit("snapshot", "null");
      expect(h.current().meta?.model).toBe("");
      expect(h.current().events).toEqual([]);
      expect(h.current().connection).toBe("live");
    });

    test("history that is not an array is treated as empty", () => {
      const h = mountFeed();
      FakeEventSource.last.emit("snapshot", { ...meta(), history: { 0: ev() } });
      expect(h.current().events).toEqual([]);
    });

    test("keeps only the newest 1000 events and averages over those", () => {
      const h = mountFeed();
      // the first 5 events have a huge latency; they must be dropped from the average
      const history = blocks(1005, BASE_BLOCK, (i) => ({ decision: decision("sell", 0.6, i < 5 ? 10_000 : 50) }));
      FakeEventSource.last.snapshot(meta(), history);
      const s = h.current();
      expect(s.events.length).toBe(1000);
      expect(s.events[0].block).toBe(BASE_BLOCK + 5);
      expect(s.latest?.block).toBe(BASE_BLOCK + 1004);
      expect(s.avgLatencyMs).toBe(50);
    });

    test("a snapshot after a reconnect replaces the history wholesale", () => {
      const h = mountFeed();
      FakeEventSource.last.snapshot(meta(), blocks(3));
      FakeEventSource.last.snapshot(meta({ model: "mock" }), blocks(2, BASE_BLOCK + 100));
      expect(h.current().events.map((e) => e.block)).toEqual([BASE_BLOCK + 100, BASE_BLOCK + 101]);
      expect(h.current().meta?.model).toBe("mock");
    });

    test("events with a non-finite or missing latency do not count", () => {
      const h = mountFeed();
      const d = decision("buy");
      FakeEventSource.last.snapshot(meta(), [
        ev(BASE_BLOCK, { decision: { ...d, latencyMs: 90 } }),
        ev(BASE_BLOCK + 1, { decision: null }),
        ev(BASE_BLOCK + 2, { decision: { ...d, latencyMs: "fast" as unknown as number } }),
        // JSON has no Infinity, so it arrives as null
        ev(BASE_BLOCK + 3, { decision: { ...d, latencyMs: Number.POSITIVE_INFINITY } }),
      ]);
      expect(h.current().avgLatencyMs).toBe(90);
    });
  });

  describe("block", () => {
    test("appends, moves latest and keeps a running latency average", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), []);
      es.block(ev(BASE_BLOCK, { decision: decision("buy", 0.77, 81) }));
      expect(h.current().avgLatencyMs).toBe(81);
      es.block(ev(BASE_BLOCK + 1, { decision: decision("sell", 0.6, 100) }));
      expect(h.current().avgLatencyMs).toBe(91); // 90.5 rounds up
      es.block(ev(BASE_BLOCK + 2, { decision: lateDecision(), quote: null }));
      expect(h.current().avgLatencyMs).toBe(91);
      expect(h.current().events.map((e) => e.block)).toEqual([BASE_BLOCK, BASE_BLOCK + 1, BASE_BLOCK + 2]);
      expect(h.current().latest?.decision?.late).toBe(true);
    });

    test("works before any snapshot (state starts empty)", () => {
      const h = mountFeed();
      FakeEventSource.last.block(ev());
      expect(h.current().events.length).toBe(1);
      expect(h.current().latest?.block).toBe(BASE_BLOCK);
      // a block does not change the connection state by itself
      expect(h.current().connection).toBe("connecting");
    });

    test("gaps in block numbers are kept", () => {
      const h = mountFeed();
      FakeEventSource.last.block(ev(BASE_BLOCK));
      FakeEventSource.last.block(ev(BASE_BLOCK + 5));
      expect(h.current().events.map((e) => e.block)).toEqual([BASE_BLOCK, BASE_BLOCK + 5]);
    });

    test("a re-sent block replaces the copy we have and fixes the average", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), [
        ev(BASE_BLOCK, { decision: decision("buy", 0.7, 100) }),
        ev(BASE_BLOCK + 1, { decision: decision("buy", 0.7, 200) }),
      ]);
      expect(h.current().avgLatencyMs).toBe(150);
      // re-send the older block with a different latency
      const resent = ev(BASE_BLOCK, { decision: decision("sell", 0.9, 300) });
      es.block(resent);
      expect(h.current().events.length).toBe(2);
      expect(h.current().events[0]).toEqual(resent);
      expect(h.current().latest?.block).toBe(BASE_BLOCK + 1);
      expect(h.current().avgLatencyMs).toBe(250);
      // re-send the newest block as late: it leaves the average
      es.block(ev(BASE_BLOCK + 1, { decision: lateDecision() }));
      expect(h.current().avgLatencyMs).toBe(300);
      expect(h.current().latest?.decision?.late).toBe(true);
      // and a late block re-sent as decided enters it again
      es.block(ev(BASE_BLOCK + 1, { decision: decision("buy", 0.7, 100) }));
      expect(h.current().avgLatencyMs).toBe(200);
    });

    test("a stale block we never had is dropped (state object unchanged)", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), [ev(BASE_BLOCK + 10), ev(BASE_BLOCK + 12)]);
      const state = h.current();
      es.block(ev(BASE_BLOCK + 3)); // older than anything we hold
      es.block(ev(BASE_BLOCK + 11)); // inside a gap
      expect(h.current()).toBe(state);
    });

    test("malformed block payloads are ignored", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), [ev()]);
      const state = h.current();
      es.emit("block", "null");
      es.emit("block", { block: "105488270" });
      es.emit("block", "{not json");
      es.emit("block", "");
      es.emit("block", undefined);
      expect(h.current()).toBe(state);
    });

    test("caps the window at 1000 events, dropping the oldest from the average", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(1000, BASE_BLOCK, (i) => ({ decision: i < 2 ? decision("buy", 0.7, 5000) : decision("buy", 0.7, 100) })));
      expect(h.current().avgLatencyMs).toBe(110); // (2 * 5000 + 998 * 100) / 1000 = 109.8
      es.block(ev(BASE_BLOCK + 1000, { decision: decision("buy", 0.7, 100) }));
      expect(h.current().events.length).toBe(1000);
      expect(h.current().events[0].block).toBe(BASE_BLOCK + 1);
      expect(h.current().avgLatencyMs).toBe(105); // (5000 + 999 * 100) / 1000 = 104.9
      es.block(ev(BASE_BLOCK + 1001, { decision: decision("buy", 0.7, 100) }));
      expect(h.current().events[0].block).toBe(BASE_BLOCK + 2);
      expect(h.current().avgLatencyMs).toBe(100);
      expect(h.current().latest?.block).toBe(BASE_BLOCK + 1001);
    });

    test("dropping a late block over the cap leaves the average alone", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(1000, BASE_BLOCK, (i) => ({ decision: i === 0 ? lateDecision() : decision("buy", 0.7, 100) })));
      es.block(ev(BASE_BLOCK + 1000, { decision: decision("buy", 0.7, 100) }));
      expect(h.current().avgLatencyMs).toBe(100);
      expect(h.current().events.length).toBe(1000);
    });

    test("the window never grows past 1000 over a long run", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      for (let i = 0; i < 1100; i++) es.block(ev(BASE_BLOCK + i, { decision: decision("buy", 0.7, 50 + (i % 3)) }));
      const s = h.current();
      expect(s.events.length).toBe(1000);
      expect(s.events[0].block).toBe(BASE_BLOCK + 100);
      expect(s.avgLatencyMs).toBe(51);
    });
  });

  describe("fill and quote", () => {
    test("a fill lands on its block; on the newest block it also updates latest", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(3));
      const f = fill({ side: "sell", size: 150 });
      es.emit("fill", { block: BASE_BLOCK + 2, fill: f });
      expect(h.current().events[2].fill).toEqual(f);
      expect(h.current().latest?.fill).toEqual(f);
      expect(h.current().latest).toBe(h.current().events[2]);
    });

    test("a fill on an older block leaves latest untouched", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(3));
      const latest = h.current().latest;
      es.emit("fill", { block: BASE_BLOCK, fill: fill() });
      expect(h.current().events[0].fill).toEqual(fill());
      expect(h.current().latest).toBe(latest);
    });

    test("a quote receipt replaces the block's quote (sent -> placed / reverted / lost)", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(3, BASE_BLOCK, () => ({ quote: quote({ status: "sent", orderId: null }) })));
      es.emit("quote", { block: BASE_BLOCK + 1, quote: quote({ status: "placed" }) });
      es.emit("quote", { block: BASE_BLOCK + 2, quote: quote({ status: "reverted", orderId: null }) });
      expect(h.current().events.map((e) => e.quote?.status)).toEqual(["sent", "placed", "reverted"]);
      expect(h.current().latest?.quote?.status).toBe("reverted");
      const latest = h.current().latest;
      es.emit("quote", { block: BASE_BLOCK, quote: quote({ status: "lost", orderId: null }) });
      expect(h.current().events[0].quote?.status).toBe("lost");
      expect(h.current().latest).toBe(latest);
    });

    test("fills and quotes for an old unknown block or with a bad payload are ignored", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(2));
      const state = h.current();
      es.emit("fill", { block: BASE_BLOCK - 5, fill: fill() });
      es.emit("fill", { block: String(BASE_BLOCK), fill: fill() });
      es.emit("fill", { block: BASE_BLOCK });
      es.emit("fill", "null");
      es.emit("quote", { block: BASE_BLOCK - 5, quote: quote() });
      es.emit("quote", { quote: quote() });
      es.emit("quote", { block: BASE_BLOCK, quote: null });
      es.emit("quote", "null");
      expect(h.current()).toBe(state);
    });

    // Regression: a fill (or quote) that overtakes its own block on the wire used to be dropped, so
    // it never reached the feed or the chart although totals.fills counted it.
    test("a held quote lands on its block; held items for a block that never comes are dropped", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(2));
      const before = h.current();
      const q = quote({ status: "placed", orderId: 7 });
      es.emit("quote", { block: BASE_BLOCK + 2, quote: q });
      es.emit("fill", { block: BASE_BLOCK + 3, fill: fill() }); // block +3 is skipped by the server
      expect(h.current().events).toBe(before.events); // nothing visible changes yet
      es.block(ev(BASE_BLOCK + 2));
      expect(h.current().latest?.quote).toEqual(q);
      expect(h.current().latest?.fill ?? null).toBeNull();
      es.block(ev(BASE_BLOCK + 4));
      expect(h.current().latest?.fill ?? null).toBeNull(); // the +3 fill does not leak onto +4
      expect(h.current().events.find((e) => e.block === BASE_BLOCK + 3)).toBeUndefined();
    });

    test("at most 50 early fills are held, newest kept", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(2));
      for (let i = 0; i < 60; i++) es.emit("fill", { block: BASE_BLOCK + 2 + i, fill: fill({ orderId: i }) });
      es.block(ev(BASE_BLOCK + 2)); // the oldest held fill was pushed out by newer ones
      expect(h.current().latest?.fill ?? null).toBeNull();
      es.block(ev(BASE_BLOCK + 61));
      expect(h.current().latest?.fill?.orderId).toBe(59);
    });

    test("a fill that arrives just before its block event is not lost", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.snapshot(meta(), blocks(2));
      const f = fill({ simulated: true, txHash: null });
      es.emit("fill", { block: BASE_BLOCK + 2, fill: f });
      es.block(ev(BASE_BLOCK + 2));
      expect(h.current().latest?.fill).toEqual(f);
    });
  });

  describe("reconnect", () => {
    test("an error closes the stream, shows reconnecting and retries after 1s", () => {
      const h = mountFeed();
      const first = FakeEventSource.last;
      first.open();
      first.fail();
      expect(h.current().connection).toBe("reconnecting");
      expect(first.closed).toBe(true);
      expect(first.onerror).toBeNull();
      advance(999);
      expect(FakeEventSource.instances.length).toBe(1);
      advance(1);
      expect(FakeEventSource.instances.length).toBe(2);
      expect(FakeEventSource.last.url).toBe(`${API}/events`);
      expect(h.current().connection).toBe("reconnecting");
      FakeEventSource.last.open();
      expect(h.current().connection).toBe("live");
    });

    test("backoff doubles 1s, 2s, 4s, 8s and caps at 10s", () => {
      mountFeed();
      const delays: number[] = [];
      for (let i = 0; i < 7; i++) {
        const before = FakeEventSource.instances.length;
        FakeEventSource.last.fail();
        let waited = 0;
        while (FakeEventSource.instances.length === before) {
          advance(250);
          waited += 250;
          if (waited > 60_000) throw new Error("no reconnect");
        }
        delays.push(waited);
      }
      expect(delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    });

    test("a successful open resets the backoff", () => {
      mountFeed();
      FakeEventSource.last.fail();
      advance(1000);
      FakeEventSource.last.fail();
      advance(2000);
      expect(FakeEventSource.instances.length).toBe(3);
      FakeEventSource.last.open();
      FakeEventSource.last.fail();
      advance(1000);
      expect(FakeEventSource.instances.length).toBe(4);
    });

    test("data survives a reconnect until the next snapshot", () => {
      const h = mountFeed();
      FakeEventSource.last.snapshot(meta(), blocks(3));
      FakeEventSource.last.fail();
      expect(h.current().events.length).toBe(3);
      expect(h.current().meta?.wallet).toBe(WALLET);
      advance(1000);
      FakeEventSource.last.snapshot(meta(), blocks(5));
      expect(h.current().events.length).toBe(5);
      expect(h.current().connection).toBe("live");
    });

    test("silence for 45s after open forces a reconnect", () => {
      const h = mountFeed();
      const first = FakeEventSource.last;
      first.open();
      advance(44_999);
      expect(first.closed).toBe(false);
      expect(h.current().connection).toBe("live");
      advance(1);
      expect(first.closed).toBe(true);
      expect(h.current().connection).toBe("reconnecting");
      advance(1000);
      expect(FakeEventSource.instances.length).toBe(2);
    });

    test("any message (ping, block, even malformed) re-arms the stale timer", () => {
      mountFeed();
      const es = FakeEventSource.last;
      es.open();
      advance(40_000);
      es.emit("ping", Date.now());
      advance(40_000);
      es.block(ev());
      advance(40_000);
      es.emit("block", "{garbage");
      advance(44_999);
      expect(es.closed).toBe(false);
      advance(1);
      expect(es.closed).toBe(true);
    });

    // Regression: the stale timer used to be armed only by onopen and by messages, so a stream that
    // neither opens nor errors (a proxy that accepts and stalls) stayed on "connecting" forever.
    test("a connection that never opens is retried after the stale timeout", () => {
      mountFeed();
      advance(60_000);
      expect(FakeEventSource.instances.length).toBeGreaterThan(1);
    });

    test("unmount closes the stream and cancels every timer", () => {
      const h = mountFeed();
      const es = FakeEventSource.last;
      es.open();
      h.unmount();
      expect(es.closed).toBe(true);
      advance(120_000);
      expect(FakeEventSource.instances.length).toBe(1);
    });

    test("unmount during a pending retry cancels the retry", () => {
      const h = mountFeed();
      FakeEventSource.last.fail();
      h.unmount();
      advance(60_000);
      expect(FakeEventSource.instances.length).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    test("unmount before anything happened leaves no timers behind", () => {
      const h = mountFeed();
      h.unmount();
      expect(FakeEventSource.last.closed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  test("a full session: snapshot, blocks, receipts, a fill, a drop and recovery", () => {
    const h = mountFeed();
    let es = FakeEventSource.last;
    es.open();
    es.snapshot(meta({ startedAt: STARTED_AT }), blocks(3));
    es.block(ev(BASE_BLOCK + 3, { quote: quote({ status: "sent", orderId: null }) }));
    es.emit("quote", { block: BASE_BLOCK + 3, quote: quote({ status: "placed" }) });
    es.block(ev(BASE_BLOCK + 4));
    es.emit("fill", { block: BASE_BLOCK + 4, fill: fill() });
    es.emit("ping", Date.now());
    expect(h.current().latest?.fill).toEqual(fill());
    expect(h.current().events[3].quote?.status).toBe("placed");
    es.fail();
    expect(h.current().connection).toBe("reconnecting");
    advance(1000);
    es = FakeEventSource.last;
    es.open();
    es.snapshot(meta(), blocks(6));
    expect(h.current().connection).toBe("live");
    expect(h.current().events.length).toBe(6);
  });
});
