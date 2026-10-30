import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { renderToString } from "react-dom/server";
import useUptimeDefault, { useUptime } from "../src/lib/useUptime";
import { WEB, cleanup, renderHook, run } from "./helpers";

const NOW = Date.UTC(2026, 9, 29, 16, 13, 42);
const advance = (ms: number) => run(() => jest.advanceTimersByTime(ms));

describe.skipIf(!WEB)("lib/useUptime", () => {
  beforeEach(() => {
    // (bun 1.3: setSystemTime() is not kept by advanceTimersByTime(), so pin the clock here)
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test("default export is the hook", () => {
    expect(useUptimeDefault).toBe(useUptime);
  });

  test("server render is always 00:00:00 (no hydration mismatch)", () => {
    function Probe() {
      return <span>{useUptime(NOW - 3_723_000)}</span>;
    }
    expect(renderToString(<Probe />)).toBe("<span>00:00:00</span>");
  });

  test("ticks once a second from a ms epoch", () => {
    const h = renderHook<number | null, string>((s) => useUptime(s), NOW - 3_723_000);
    expect(h.current()).toBe("01:02:03");
    advance(999);
    expect(h.current()).toBe("01:02:03");
    advance(1);
    expect(h.current()).toBe("01:02:04");
    advance(60_000);
    expect(h.current()).toBe("01:03:04");
  });

  test("accepts a seconds epoch", () => {
    const h = renderHook<number | null, string>((s) => useUptime(s), (NOW - 59_000) / 1000);
    expect(h.current()).toBe("00:00:59");
    advance(1000);
    expect(h.current()).toBe("00:01:00");
  });

  test("null, undefined and 0 stay at zeros and start no interval", () => {
    for (const s of [null, undefined, 0]) {
      const h = renderHook((v: number | null | undefined) => useUptime(v), s);
      expect(h.current()).toBe("00:00:00");
      expect(jest.getTimerCount()).toBe(0);
      h.unmount();
    }
  });

  test("a new startedAt restarts the clock; clearing it resets to zeros", () => {
    const h = renderHook<number | null, string>((s) => useUptime(s), NOW - 10_000);
    expect(h.current()).toBe("00:00:10");
    h.rerender(NOW - 7_200_000);
    expect(h.current()).toBe("02:00:00");
    expect(jest.getTimerCount()).toBe(1);
    h.rerender(null);
    expect(h.current()).toBe("00:00:00");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("unmount stops the interval", () => {
    const h = renderHook<number | null, string>((s) => useUptime(s), NOW);
    expect(jest.getTimerCount()).toBe(1);
    h.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
