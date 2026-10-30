import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { renderToString } from "react-dom/server";
import StatsRow from "../src/components/StatsRow/StatsRow";
import type { BlockEvent, Meta } from "../src/lib/types";
import { BASE_BLOCK, WEB, cleanup, decision, ev, lateDecision, meta, render, run, totals } from "./helpers";

const NOW = Date.UTC(2026, 9, 29, 16, 13, 42);

function spans(latest: BlockEvent | null, avg: number, m: Meta | null) {
  const r = render(<StatsRow latest={latest} avgLatencyMs={avg} meta={m} />);
  const read = () =>
    r
      .$$(".stats > span")
      .map((s) => s.textContent)
      .filter(Boolean);
  return { r, read };
}

describe.skipIf(!WEB)("StatsRow", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test("no data yet", () => {
    const { read } = spans(null, 0, null);
    expect(read()).toEqual(["last - ms", "avg -", "- calls", "- fills", "uptime 00:00:00"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("server render shows zeros for uptime", () => {
    const html = renderToString(<StatsRow latest={ev()} avgLatencyMs={90} meta={meta({ startedAt: NOW - 5000 })} />);
    expect(html.replace(/<!-- -->/g, "")).toContain("uptime 00:00:00");
  });

  test("live: last latency, rounded average, call and fill counts, ticking uptime", () => {
    const latest = ev(BASE_BLOCK, { decision: decision("buy", 0.7, 81), totals: totals({ decisions: 12_345, fills: 67 }) });
    const { read } = spans(latest, 107.4, meta({ startedAt: NOW - 3_723_000 }));
    expect(read()).toEqual(["last 81 ms", "avg 107ms", "12,345 calls", "67 fills", "uptime 01:02:03"]);
    run(() => jest.advanceTimersByTime(1000));
    expect(read()[4]).toBe("uptime 01:02:04");
  });

  test("a seconds-epoch startedAt is handled", () => {
    const { read } = spans(ev(), 50, meta({ startedAt: (NOW - 61_000) / 1000 }));
    expect(read()[4]).toBe("uptime 00:01:01");
  });

  test("late latest block: last shows '- ms'", () => {
    const { read } = spans(ev(BASE_BLOCK, { decision: lateDecision() }), 90, meta());
    expect(read()[0]).toBe("last - ms");
  });

  test("no decision object: last shows '- ms'", () => {
    const { read } = spans(ev(BASE_BLOCK, { decision: null }), 90, meta());
    expect(read()[0]).toBe("last - ms");
  });

  test("average of 0, negative or non-finite shows '-'", () => {
    for (const avg of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { read, r } = spans(ev(), avg, meta());
      expect(read()[1]).toBe("avg -");
      r.unmount();
    }
  });

  test("meta going away resets uptime and stops the clock", () => {
    const latest = ev();
    const r = render(<StatsRow latest={latest} avgLatencyMs={1} meta={meta({ startedAt: NOW - 10_000 })} />);
    expect(r.text()).toContain("uptime 00:00:10");
    expect(jest.getTimerCount()).toBe(1);
    r.rerender(<StatsRow latest={latest} avgLatencyMs={1} meta={null} />);
    expect(r.text()).toContain("uptime 00:00:00");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("unmount stops the clock", () => {
    const { r } = spans(ev(), 1, meta());
    expect(jest.getTimerCount()).toBe(1);
    r.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
