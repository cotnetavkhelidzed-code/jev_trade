import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Feed from "../src/components/Feed/Feed";
import type { BlockEvent } from "../src/lib/types";
import {
  BASE_BLOCK,
  FakeResizeObserver,
  TX_FILL,
  TX_QUOTE,
  WEB,
  blocks,
  cleanup,
  decision,
  ev,
  fill,
  installResizeObserver,
  lateDecision,
  quote,
  render,
  setClientHeight,
  uninstallResizeObserver,
} from "./helpers";

interface Row {
  className: string;
  block: string;
  word: string;
  conf: string;
  lat: string;
  detail: string;
  detailClass: string;
  tx: string;
  link: { href: string; title: string; className: string; target: string; rel: string } | null;
  txMuted: boolean;
}

function rowsOf(root: { $$(s: string): Element[] }): Row[] {
  return root.$$(".list > .row").map((r) => {
    const cell = (c: string) => r.querySelector(`.${c}`) as HTMLElement;
    const a = cell("tx").querySelector("a");
    return {
      className: r.className,
      block: cell("block").textContent ?? "",
      word: cell("word").textContent ?? "",
      conf: cell("conf").textContent ?? "",
      lat: cell("lat").textContent ?? "",
      detail: cell("detail").textContent ?? "",
      detailClass: cell("detail").className,
      tx: cell("tx").textContent ?? "",
      link: a
        ? {
            href: a.getAttribute("href") ?? "",
            title: a.getAttribute("title") ?? "",
            className: a.getAttribute("class") ?? "",
            target: a.getAttribute("target") ?? "",
            rel: a.getAttribute("rel") ?? "",
          }
        : null,
      txMuted: Boolean(cell("tx").querySelector("span.muted")),
    };
  });
}

function one(e: BlockEvent): Row {
  const r = render(<Feed events={[e]} />);
  const [row] = rowsOf(r);
  r.unmount();
  return row;
}

describe.skipIf(!WEB)("Feed", () => {
  beforeEach(() => {
    installResizeObserver();
    setClientHeight(26 * 15);
  });

  afterEach(() => {
    cleanup();
    setClientHeight(null);
    uninstallResizeObserver();
  });

  test("no data yet", () => {
    const r = render(<Feed events={[]} />);
    expect(r.$(".label")?.textContent).toBe("FEED");
    expect(r.$(".empty")?.textContent).toBe("no blocks yet");
    expect(rowsOf(r)).toEqual([]);
  });

  test("newest first, one row per block, newest row marked", () => {
    const r = render(<Feed events={blocks(3)} />);
    const rows = rowsOf(r);
    expect(rows.map((x) => x.block)).toEqual(["105,488,271", "105,488,270", "105,488,269"]);
    expect(rows[0].className.split(" ")).toContain("newest");
    expect(rows[1].className.split(" ")).not.toContain("newest");
  });

  test("buy with a placed quote: BUY, conf, latency, bid detail, tx link", () => {
    const row = one(ev(BASE_BLOCK, { decision: decision("buy", 0.77, 81), quote: quote({ price: 0.022629, size: 200 }) }));
    expect(row).toMatchObject({
      word: "BUY",
      conf: "conf 0.77",
      lat: "81ms",
      detail: "bid 200 @ 0.022629",
      tx: "0x8f2c…",
      txMuted: false,
    });
    expect(row.className.split(" ")).toEqual(["row", "kindBuy", "newest"]);
    expect(row.detailClass).toBe("cell detail");
    expect(row.link).toEqual({
      href: `https://monadvision.com/tx/${TX_QUOTE}`,
      title: "placed",
      className: "",
      target: "_blank",
      rel: "noreferrer",
    });
  });

  test("sell: SELL with an ask detail", () => {
    const row = one(ev(BASE_BLOCK, { decision: decision("sell", 0.64, 95), quote: quote({ side: "sell", price: 0.022644, size: 1234.567 }) }));
    expect(row.word).toBe("SELL");
    expect(row.conf).toBe("conf 0.64");
    expect(row.detail).toBe("ask 1,234.57 @ 0.022644");
    expect(row.className.split(" ")).toContain("kindSell");
  });

  test("sent quote: the tx link is dimmed as pending", () => {
    const row = one(ev(BASE_BLOCK, { quote: quote({ status: "sent", orderId: null }) }));
    expect(row.link?.className).toBe("pending");
    expect(row.link?.title).toBe("sent");
    expect(row.tx).toBe("0x8f2c…");
    expect(row.detailClass).toBe("cell detail");
  });

  test("reverted quote: 'rev', muted detail and link", () => {
    const row = one(ev(BASE_BLOCK, { quote: quote({ status: "reverted", orderId: null }) }));
    expect(row.tx).toBe("rev");
    expect(row.link?.className).toBe("muted");
    expect(row.link?.title).toBe("reverted");
    expect(row.detailClass).toBe("cell detail muted");
  });

  test("lost quote: 'lost', muted detail and link", () => {
    const row = one(ev(BASE_BLOCK, { quote: quote({ status: "lost", orderId: null }) }));
    expect(row.tx).toBe("lost");
    expect(row.link?.className).toBe("muted");
    expect(row.detailClass).toBe("cell detail muted");
  });

  test("capped quote: ' cap' suffix", () => {
    const d = { ...decision("buy", 0.8), action: "sell" as const };
    const row = one(ev(BASE_BLOCK, { decision: d, quote: quote({ side: "sell", capped: true }) }));
    expect(row.word).toBe("SELL");
    expect(row.detail).toBe("ask 200 @ 0.022629 cap");
    expect(row.conf).toBe("conf 0.80");
  });

  test("dry run: sim quote shows 'sim', no link", () => {
    const row = one(ev(BASE_BLOCK, { quote: quote({ status: "sim", txHash: null, orderId: null, gasMon: 0 }) }));
    expect(row.tx).toBe("sim");
    expect(row.txMuted).toBe(true);
    expect(row.link).toBeNull();
    expect(row.detail).toBe("bid 200 @ 0.022629");
  });

  test("dry run with a simulated fill: FILL detail, still 'sim' in the tx column", () => {
    const row = one(
      ev(BASE_BLOCK, {
        quote: quote({ status: "sim", txHash: null, orderId: null }),
        fill: fill({ simulated: true, txHash: null, size: 150, price: 0.02263 }),
      }),
    );
    expect(row.detail).toBe("FILL 150 @ 0.022630");
    expect(row.className.split(" ")).toContain("filled");
    expect(row.tx).toBe("sim");
    expect(row.link).toBeNull();
  });

  test("live fill: FILL detail and the taker's tx", () => {
    const row = one(ev(BASE_BLOCK, { fill: fill({ side: "sell", size: 200, price: 0.022651 }) }));
    expect(row.detail).toBe("FILL 200 @ 0.022651");
    expect(row.className.split(" ")).toEqual(["row", "kindBuy", "newest", "filled"]);
    expect(row.link).toEqual({
      href: `https://monadvision.com/tx/${TX_FILL}`,
      title: "the taker's transaction",
      className: "",
      target: "_blank",
      rel: "noreferrer",
    });
    expect(row.tx).toBe("0x1d9e…");
  });

  test("a zero-size fill falls back to the quote detail", () => {
    const row = one(ev(BASE_BLOCK, { fill: fill({ size: 0 }) }));
    expect(row.detail).toBe("bid 200 @ 0.022629");
  });

  test("decided without a quote: 'no quote', muted, empty tx", () => {
    const row = one(ev(BASE_BLOCK, { quote: null }));
    expect(row.detail).toBe("no quote");
    expect(row.detailClass).toBe("cell detail muted");
    expect(row.tx).toBe("");
  });

  test("a quote with no tx hash and a live status shows nothing in the tx column", () => {
    const row = one(ev(BASE_BLOCK, { quote: quote({ txHash: null }) }));
    expect(row.tx).toBe("");
    expect(row.link).toBeNull();
  });

  test("late block: LATE, no conf, no latency, no detail", () => {
    const row = one(ev(BASE_BLOCK, { decision: lateDecision(), quote: null }));
    expect(row).toMatchObject({ word: "LATE", conf: "", lat: "", detail: "", tx: "" });
    expect(row.className.split(" ")).toContain("kindLate");
  });

  test("late block that still got a fill on a resting order shows the fill", () => {
    const row = one(ev(BASE_BLOCK, { decision: lateDecision(), quote: null, fill: fill() }));
    expect(row.word).toBe("LATE");
    expect(row.detail).toBe("FILL 200 @ 0.022629");
  });

  test("no decision object, or a non-late hold, is shown as LATE", () => {
    expect(one(ev(BASE_BLOCK, { decision: null })).word).toBe("LATE");
    expect(one(ev(BASE_BLOCK, { decision: { ...lateDecision(), late: false } })).word).toBe("LATE");
    // and a late row never shows its quote
    expect(one(ev(BASE_BLOCK, { decision: null })).detail).toBe("");
  });

  test("shows as many whole rows as fit (26px each)", () => {
    setClientHeight(26 * 5 + 20);
    const r = render(<Feed events={blocks(30)} />);
    expect(rowsOf(r).length).toBe(5);
    expect(rowsOf(r)[0].block).toBe("105,488,298");
  });

  test("at least one row even in a zero-height box", () => {
    setClientHeight(0);
    const r = render(<Feed events={blocks(3)} />);
    expect(rowsOf(r).length).toBe(1);
  });

  test("never more than 40 rows", () => {
    setClientHeight(26 * 100);
    const r = render(<Feed events={blocks(60)} />);
    expect(rowsOf(r).length).toBe(40);
  });

  test("re-measures when the box resizes, and disconnects on unmount", () => {
    setClientHeight(26 * 4);
    const r = render(<Feed events={blocks(30)} />);
    expect(rowsOf(r).length).toBe(4);
    const ro = FakeResizeObserver.instances.at(-1)!;
    expect(ro.targets[0]).toBe(r.$(".list") as Element);
    setClientHeight(26 * 10);
    ro.resize(400, 260);
    expect(rowsOf(r).length).toBe(10);
    ro.resize(400, 260); // same size: no change
    expect(rowsOf(r).length).toBe(10);
    r.unmount();
    expect(ro.disconnected).toBe(true);
  });

  test("without ResizeObserver it measures once", () => {
    uninstallResizeObserver();
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    setClientHeight(26 * 3);
    const r = render(<Feed events={blocks(10)} />);
    expect(rowsOf(r).length).toBe(3);
    r.unmount();
    installResizeObserver();
  });

  test("new blocks push old rows out of the window", () => {
    setClientHeight(26 * 3);
    const evs = blocks(3);
    const r = render(<Feed events={evs} />);
    r.rerender(<Feed events={[...evs, ev(BASE_BLOCK + 3, { decision: decision("sell") })]} />);
    const rows = rowsOf(r);
    expect(rows.map((x) => x.block)).toEqual(["105,488,272", "105,488,271", "105,488,270"]);
    expect(rows[0].word).toBe("SELL");
  });
});
