import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import {
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
  quote,
  render,
  run,
  setClientHeight,
  uninstallEventSource,
  uninstallResizeObserver,
} from "./helpers";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://jev-trader-production.up.railway.app";

describe.skipIf(!WEB)("app/layout", () => {
  let layout: Awaited<ReturnType<typeof loadLayout>>;

  beforeAll(async () => {
    layout = await loadLayout();
  });

  test("renders html/body with the font variables and the children", () => {
    const RootLayout = layout.default as ComponentType<{ children: ReactNode }>;
    const html = renderToStaticMarkup(
      <RootLayout>
        <main>hello</main>
      </RootLayout>,
    );
    // (React 19 inserts an empty <head> when it renders a whole document)
    expect(html).toBe('<html lang="en" class="inter-variable mono-variable"><head></head><body><main>hello</main></body></html>');
  });

  test("metadata and viewport", () => {
    expect(layout.metadata).toEqual({ title: "Jev Trader", description: "One AI trade decision every Monad block." });
    expect(layout.viewport).toEqual({ width: "device-width", initialScale: 1, themeColor: "#F0EEE9" });
  });
});

describe.skipIf(!WEB)("app/page", () => {
  let Page: ComponentType;

  beforeAll(async () => {
    Page = (await import("../src/app/page")).default;
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: STARTED_AT + 3_723_000 });
    installEventSource();
    installResizeObserver();
    setClientHeight(26 * 8);
  });

  afterEach(() => {
    cleanup();
    setClientHeight(null);
    uninstallResizeObserver();
    uninstallEventSource();
    jest.useRealTimers();
  });

  test("server render: the empty, SSR-safe first paint", () => {
    const html = renderToString(<Page />).replace(/<!-- -->/g, "");
    expect(html).toContain("block -");
    expect(html).toContain("connecting");
    expect(html).toContain("dry run");
    expect(html).toContain("waiting for blocks…");
    expect(html).toContain("no blocks yet");
    expect(html).toContain("uptime 00:00:00");
  });

  test("connects to the configured API", () => {
    render(<Page />);
    expect(FakeEventSource.last.url).toBe(`${API.replace(/\/+$/, "")}/events`);
  });

  test("a live session end to end", () => {
    const r = render(<Page />);
    const es = FakeEventSource.last;
    expect(r.text()).toContain("connecting");

    es.open();
    es.snapshot(meta(), blocks(20));
    FakeResizeObserver.resizeAll(800, 500);
    expect(r.text()).not.toContain("connecting");
    expect(r.$(".block")?.textContent).toBe(`block ${(BASE_BLOCK + 19).toLocaleString("en-US")}`);
    expect(r.$(".badge")?.textContent).toBe("jev-latest");
    expect(r.text()).toContain("uptime 01:02:03");
    expect(r.$$(".list > .row").length).toBe(8);
    expect(r.$("path.line")).not.toBeNull();
    expect(r.$(".headlineWord")?.textContent).toBe("BUY");

    es.block(ev(BASE_BLOCK + 20, { decision: decision("sell", 0.66, 90), quote: quote({ side: "sell", status: "sent", orderId: null }) }));
    expect(r.$(".headlineWord")?.textContent).toBe("SELL");
    expect(r.$(".tr .word")?.textContent).toBe("Selling");
    expect(r.$(".list > .row .word")?.textContent).toBe("SELL");
    expect(r.$(".list > .row a")?.getAttribute("class")).toBe("pending");

    es.emit("quote", { block: BASE_BLOCK + 20, quote: quote({ side: "sell", status: "reverted", orderId: null }) });
    expect(r.$(".list > .row .tx")?.textContent).toBe("rev");

    es.emit("fill", { block: BASE_BLOCK + 20, fill: fill({ side: "sell" }) });
    expect(r.$(".list > .row .detail")?.textContent).toBe("FILL 200 @ 0.022629");
    expect(r.$$("g.slide > circle").length).toBeGreaterThan(0);

    es.block(ev(BASE_BLOCK + 21, { decision: lateDecision(), quote: null }));
    expect(r.$(".headlineWord")?.textContent).toBe("LATE");
    expect(r.$(".tr .word")?.textContent).toBe("Missed the block");

    es.fail();
    expect(r.$(".offline")?.textContent).toBe("reconnecting");
    run(() => jest.advanceTimersByTime(1000));
    FakeEventSource.last.open();
    expect(r.$(".offline")).toBeNull();
  });

  test("dry run with the stand-in model", () => {
    const r = render(<Page />);
    FakeEventSource.last.snapshot(
      meta({ model: "mock", wallet: null, dryRun: true }),
      blocks(5, BASE_BLOCK, (i) => ({
        quote: quote({ status: "sim", txHash: null, orderId: null, gasMon: 0 }),
        fill: i === 4 ? fill({ simulated: true, txHash: null }) : null,
      })),
    );
    expect(r.$("button")?.textContent).toBe("dry run");
    expect((r.$(".badge") as HTMLElement).style.background).toBe("var(--badge-standin-bg)");
    expect(r.$(".list > .row .tx")?.textContent).toBe("sim");
  });
});
