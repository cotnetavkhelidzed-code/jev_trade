/**
 * The repo's CLAUDE.md forbids middle dots (U+00B7), em dashes (U+2014) and en dashes (U+2013) in
 * any rendered text. Render every component in every state (and the whole page through a live
 * session) and scan the resulting HTML, text and attributes included.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import DecisionPanel from "../src/components/DecisionPanel/DecisionPanel";
import Feed from "../src/components/Feed/Feed";
import FlowChart from "../src/components/FlowChart/FlowChart";
import Header from "../src/components/Header/Header";
import StatsRow from "../src/components/StatsRow/StatsRow";
import type { BlockEvent, ConnectionState, Meta } from "../src/lib/types";
import {
  BANNED,
  BASE_BLOCK,
  FakeEventSource,
  FakeResizeObserver,
  STARTED_AT,
  WEB,
  blocks,
  cleanup,
  decision,
  ev,
  fill,
  installEventSource,
  installResizeObserver,
  lateDecision,
  loadLayout,
  meta,
  position,
  quote,
  render,
  run,
  setClientHeight,
  totals,
  uninstallEventSource,
  uninstallResizeObserver,
} from "./helpers";

function offenders(html: string): string[] {
  const out: string[] = [];
  const re = new RegExp(BANNED.source, "g");
  for (const m of html.matchAll(re)) {
    const at = m.index ?? 0;
    const name = { "·": "U+00B7 middle dot", "—": "U+2014 em dash", "–": "U+2013 en dash" }[m[0]];
    out.push(`${name} in "...${html.slice(Math.max(0, at - 40), at + 40)}..."`);
  }
  return out;
}

/** Every event shape the backend can send, for list-style components. */
const VARIANTS: BlockEvent[] = [
  ev(BASE_BLOCK, { decision: decision("buy", 0.77, 81) }),
  ev(BASE_BLOCK + 1, { decision: decision("sell", 0.64, 95), quote: quote({ side: "sell", status: "sent", orderId: null }) }),
  ev(BASE_BLOCK + 2, { quote: quote({ status: "reverted", orderId: null }) }),
  ev(BASE_BLOCK + 3, { quote: quote({ status: "lost", orderId: null }) }),
  ev(BASE_BLOCK + 4, { decision: { ...decision("buy", 0.8), action: "sell" }, quote: quote({ side: "sell", capped: true }) }),
  ev(BASE_BLOCK + 5, { quote: quote({ status: "sim", txHash: null, orderId: null, gasMon: 0 }) }),
  ev(BASE_BLOCK + 6, { quote: quote({ status: "sim", txHash: null, orderId: null }), fill: fill({ simulated: true, txHash: null }) }),
  ev(BASE_BLOCK + 7, { fill: fill({ side: "sell", size: 1234.5678 }) }),
  ev(BASE_BLOCK + 8, { quote: null }),
  ev(BASE_BLOCK + 9, { decision: lateDecision(), quote: null }),
  ev(BASE_BLOCK + 10, { decision: null, quote: null }),
  ev(BASE_BLOCK + 11, { decision: { ...lateDecision(), late: false } }),
  ev(BASE_BLOCK + 12, {
    position: position({ side: "short", size: 12.5, entryPrice: 0.022633, unrealizedUsd: -0.0006, unrealizedMon: -0.027 }),
    totals: totals({ pnlUsd: -0.003, pnlMon: -0.13, pnlPct: -0.003 }),
  }),
  ev(BASE_BLOCK + 13, { position: position({ side: "long", size: 200, entryPrice: 0.02263 }) }),
];

const METAS: (Meta | null)[] = [
  null,
  meta(),
  meta({ model: "mock", wallet: null, dryRun: true }),
  meta({ model: "", startedAt: STARTED_AT / 1000 }),
];
const CONNECTIONS: ConnectionState[] = ["connecting", "live", "reconnecting"];

describe.skipIf(!WEB)("rendered text has no middle dots, em dashes or en dashes", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: STARTED_AT + 3_723_000 });
    installEventSource();
    installResizeObserver();
    setClientHeight(26 * 40);
  });

  afterAll(() => {
    cleanup();
    setClientHeight(null);
    uninstallResizeObserver();
    uninstallEventSource();
    jest.useRealTimers();
  });

  const check = (html: string) => expect(offenders(html)).toEqual([]);

  test("the detector itself catches all three characters", () => {
    expect(offenders("a\u00B7b c\u2014d e\u2013f").length).toBe(3);
    expect(offenders("block 105,488,269 - hyphen \u2026 \u2016 ok")).toEqual([]);
  });

  test("Header: every meta x connection x latest, and the 'copied' flash", () => {
    for (const m of METAS)
      for (const c of CONNECTIONS)
        for (const latest of [null, VARIANTS[0]]) {
          const r = render(<Header meta={m} latest={latest} connection={c} />);
          check(r.html());
          const button = r.$("button") as HTMLButtonElement;
          if (!button.disabled) {
            run(() => button.click());
            expect(button.textContent).toBe("copied");
            check(r.html());
          }
          r.unmount();
        }
  });

  test("StatsRow: no data, live, late, every meta", () => {
    for (const m of METAS)
      for (const latest of [null, ...VARIANTS])
        for (const avg of [0, 107.4]) {
          const r = render(<StatsRow latest={latest} avgLatencyMs={avg} meta={m} />);
          check(r.html());
          r.unmount();
        }
  });

  test("DecisionPanel: no data and every event variant", () => {
    for (const latest of [null, ...VARIANTS]) {
      const r = render(<DecisionPanel latest={latest} />);
      check(r.html());
      r.unmount();
    }
  });

  test("Feed: empty and every row variant", () => {
    for (const events of [[], VARIANTS, ...VARIANTS.map((v) => [v])]) {
      const r = render(<Feed events={events} />);
      check(r.html());
      r.unmount();
    }
  });

  test("FlowChart: waiting, every headline, position and P&L, every hover tooltip", () => {
    check(render(<FlowChart events={[]} latest={null} />).html());
    for (let i = 0; i < VARIANTS.length; i++) {
      const series = [...blocks(20, BASE_BLOCK - 20), ...VARIANTS.slice(0, i + 1)];
      const r = render(<FlowChart events={series} latest={series.at(-1)!} />);
      FakeResizeObserver.instances.at(-1)!.resize(800, 500);
      check(r.html());
      // hover every block of the series
      const last = series.at(-1)!.block;
      const panel = r.$(".panel") as HTMLElement;
      for (const e of series) {
        const clientX = 800 - 88 - (last - e.block) * 10;
        run(() => {
          panel.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX }));
        });
        check(r.html());
      }
      r.unmount();
    }
  });

  test("Page: server render and a full live session (snapshot, blocks, receipts, fills, late, reconnect)", async () => {
    const Page = (await import("../src/app/page")).default;
    check(renderToString(<Page />));
    const r = render(<Page />);
    check(r.html());
    const es = FakeEventSource.last;
    es.open();
    check(r.html());
    es.snapshot(meta(), blocks(10));
    FakeResizeObserver.resizeAll(800, 500);
    check(r.html());
    for (const v of VARIANTS.map((e, i) => ({ ...e, block: BASE_BLOCK + 10 + i }))) {
      es.block(v);
      check(r.html());
    }
    es.emit("quote", { block: BASE_BLOCK + 11, quote: quote({ status: "reverted", side: "sell", orderId: null }) });
    es.emit("fill", { block: BASE_BLOCK + 12, fill: fill({ side: "sell" }) });
    check(r.html());
    es.fail();
    check(r.html());
    run(() => jest.advanceTimersByTime(1000));
    check(r.html());
    FakeEventSource.last.snapshot(meta({ model: "mock", wallet: null, dryRun: true }), VARIANTS);
    check(r.html());
    r.unmount();
  });

  test("layout markup and metadata", async () => {
    const layout = await loadLayout();
    const RootLayout = layout.default as ComponentType<{ children: ReactNode }>;
    check(renderToStaticMarkup(<RootLayout>x</RootLayout>));
    check(JSON.stringify(layout.metadata));
    check(JSON.stringify(layout.viewport));
  });
});
