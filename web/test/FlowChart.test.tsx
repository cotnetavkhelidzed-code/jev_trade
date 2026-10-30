import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import FlowChart from "../src/components/FlowChart/FlowChart";
import type { BlockEvent } from "../src/lib/types";
import {
  BASE_BLOCK,
  FakeResizeObserver,
  type Mounted,
  WEB,
  blocks,
  cleanup,
  decision,
  ev,
  fill,
  installResizeObserver,
  lateDecision,
  position,
  quote,
  render,
  run,
  totals,
  uninstallResizeObserver,
} from "./helpers";

const W = 800;
const H = 500;
const PAD_TOP = 84;
const PAD_BOTTOM = 72;

function chart(events: BlockEvent[], latest: BlockEvent | null = events.at(-1) ?? null, size: [number, number] | null = [W, H]) {
  const r = render(<FlowChart events={events} latest={latest} />);
  const ro = FakeResizeObserver.instances.at(-1)!;
  if (size) ro.resize(size[0], size[1]);
  return { r, ro };
}

const panel = (r: Mounted) => r.$(".panel") as HTMLElement;
const txt = (r: Mounted, sel: string) => r.$(sel)?.textContent ?? null;
const subs = (r: Mounted, corner: "tl" | "tr") => r.$$(`.${corner} .sub span`).map((s) => s.textContent);
const ticks = (r: Mounted) => r.$$("text.tick").map((t) => t.textContent);
const cells = (r: Mounted) =>
  r.$$("g.slide > rect").filter((x) => !x.getAttribute("class")?.includes("cellGlow") && x.getAttribute("height") === "18");
const beads = (r: Mounted) => r.$$("g.slide > circle");

/** The clientX that the chart maps to `block` (getBoundingClientRect().left is 0 in happy-dom). */
function xFor(last: number, block: number, w = W) {
  return w - 88 - (last - block) * 10;
}

function pointer(r: Mounted, type: string, init: PointerEventInit) {
  run(() => {
    panel(r).dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
  });
}

function hover(r: Mounted, clientX: number, pointerType = "mouse") {
  pointer(r, "pointermove", { pointerType, clientX });
}

function tip(r: Mounted) {
  if (!r.$("rect.tip")) return null;
  return {
    block: txt(r, ".tipBlock"),
    price: txt(r, ".tipPrice"),
    trade: txt(r, ".tipSide"),
    tint: r.$(".tipSide")?.getAttribute("fill"),
    lat: txt(r, ".tipMeta"),
    transform: r.$("rect.tip")?.parentElement?.getAttribute("transform") ?? "",
  };
}

describe.skipIf(!WEB)("FlowChart", () => {
  beforeEach(installResizeObserver);
  afterEach(() => {
    cleanup();
    uninstallResizeObserver();
  });

  test("no data yet: waiting message, no svg", () => {
    const { r } = chart([], null);
    expect(txt(r, ".empty")).toBe("waiting for blocks…");
    expect(r.$("svg")).toBeNull();
  });

  test("data but no measured size yet: waiting message", () => {
    const { r } = chart(blocks(5), undefined, null);
    expect(txt(r, ".empty")).toBe("waiting for blocks…");
  });

  test("a box too small to plot shows the waiting message", () => {
    expect(txt(chart(blocks(5), undefined, [159, H]).r, ".empty")).toBe("waiting for blocks…");
    expect(txt(chart(blocks(5), undefined, [W, PAD_TOP + PAD_BOTTOM + 59]).r, ".empty")).toBe("waiting for blocks…");
    expect(txt(chart(blocks(5), undefined, [160, PAD_TOP + PAD_BOTTOM + 60]).r, ".empty")).toBeNull();
  });

  test("live: line, area, grid, price tag, block strip and overlays", () => {
    const evs = blocks(30);
    const { r } = chart(evs);
    const svg = r.$("svg") as SVGElement;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${W} ${H}`);
    const line = r.$("path.line")?.getAttribute("d") ?? "";
    expect(line).toMatch(/^M-?\d/);
    expect(line.match(/C/g)?.length).toBe(29);
    const area = r.$("g.slide > path")?.getAttribute("d") ?? "";
    expect(area.startsWith(line)).toBe(true);
    expect(area).toMatch(new RegExp(` L290\\.0 ${H - PAD_BOTTOM} L0\\.0 ${H - PAD_BOTTOM} Z$`));
    expect(r.$$("line.grid").length).toBe(3);
    expect(ticks(r).length).toBe(3);
    expect(txt(r, ".tagText")).toBe(evs.at(-1)!.mid.toFixed(6));
    expect(cells(r).length).toBe(30);
    // the newest block sits ANCHOR_GAP from the right edge
    const slide = r.$("g.slide") as SVGGElement;
    expect(slide.getAttribute("style")).toContain(`translateX(${(W - 88 - 290).toFixed(1)}px)`);
    expect(txt(r, ".tl .price")).toBe(evs.at(-1)!.mid.toFixed(6));
    expect(subs(r, "tl")).toEqual(["MON/USDC", "Kuru", "flat", "p&l +0.130 MON (+0.00%)"]);
    expect(txt(r, ".tr .word")).toBe("Buying");
    expect(subs(r, "tr")).toEqual(["81 ms", "conf 0.77"]);
    // no fills: no beads, riser or ripple
    expect(beads(r).length).toBe(0);
    expect(r.$(".riser")).toBeNull();
  });

  test("only the window that fits is drawn", () => {
    const { r } = chart(blocks(200));
    // n = ceil((800 - 88) / 10) + 2 = 74
    expect(cells(r).length).toBe(74);
  });

  test("sell, late, hold and no-decision headlines", () => {
    const cases: [BlockEvent, string, string, string][] = [
      [ev(BASE_BLOCK, { decision: decision("sell", 0.64, 95) }), "Selling", "var(--sell-ink)", "95 ms"],
      [ev(BASE_BLOCK, { decision: lateDecision(), quote: null }), "Missed the block", "var(--late-ink)", "late"],
      [ev(BASE_BLOCK, { decision: { ...lateDecision(), late: false } }), "Holding", "var(--ink)", "0 ms"],
      [ev(BASE_BLOCK, { decision: null }), "Holding", "var(--ink)", "late"],
    ];
    for (const [e, word, color, lat] of cases) {
      const { r } = chart([e]);
      expect(txt(r, ".tr .word")).toBe(word);
      expect((r.$(".tr .word") as HTMLElement).style.color).toBe(color);
      expect(subs(r, "tr")[0]).toBe(lat);
      r.unmount();
    }
    const { r } = chart([ev(BASE_BLOCK, { decision: decision("buy", 0.77) })]);
    expect((r.$(".tr .word") as HTMLElement).style.color).toBe("var(--buy-ink)");
  });

  test("a decision with a float latency is rounded", () => {
    const { r } = chart([ev(BASE_BLOCK, { decision: decision("buy", 0.7, 80.6) })]);
    expect(subs(r, "tr")[0]).toBe("81 ms");
  });

  // Regression: late blocks carry probabilities { buy: 0, sell: 0, hold: 1 }, so the confidence
  // (max of the three) used to read "conf 1.00" next to "Missed the block".
  test("a late block does not claim 100% confidence", () => {
    const { r } = chart([ev(BASE_BLOCK, { decision: lateDecision(), quote: null })]);
    expect(txt(r, ".tr .word")).toBe("Missed the block");
    expect(subs(r, "tr").join(" ")).not.toContain("conf 1.00");
  });

  test("positions: long, short, flat, and missing", () => {
    const cases: [Partial<BlockEvent>, string][] = [
      [{ position: position({ side: "long", size: 200, entryPrice: 0.02263 }) }, "long 200 MON"],
      [{ position: position({ side: "short", size: 12.5, entryPrice: 0.02263 }) }, "short 12.500 MON"],
      [{ position: position() }, "flat"],
      [{ position: undefined as never }, "flat"],
    ];
    for (const [over, stance] of cases) {
      const { r } = chart([ev(BASE_BLOCK, over)]);
      expect(subs(r, "tl")[2]).toBe(stance);
      r.unmount();
    }
  });

  test("negative P&L is red and signed; positive is green", () => {
    const neg = chart([ev(BASE_BLOCK, { totals: totals({ pnlMon: -0.13, pnlPct: -0.13 }) })]).r;
    const span = neg.$$(".tl .sub span")[3] as HTMLElement;
    expect(span.textContent).toBe("p&l -0.130 MON (-0.13%)");
    expect(span.style.color).toBe("var(--pnl-neg)");
    neg.unmount();
    const pos = chart([ev(BASE_BLOCK, { totals: totals({ pnlMon: 1.5, pnlPct: 0.42 }) })]).r;
    const span2 = pos.$$(".tl .sub span")[3] as HTMLElement;
    expect(span2.textContent).toBe("p&l +1.500 MON (+0.42%)");
    expect(span2.style.color).toBe("var(--pnl-pos)");
  });

  test("missing totals read as zero P&L", () => {
    const { r } = chart([ev(BASE_BLOCK, { totals: undefined as never })]);
    expect(subs(r, "tl")[3]).toBe("p&l +0.000 MON (+0.00%)");
  });

  test("block strip colours: buy, sell, late, hold, fill side wins; sent quotes dimmer", () => {
    const evs = [
      ev(BASE_BLOCK, { decision: decision("buy") }),
      ev(BASE_BLOCK + 1, { decision: decision("sell") }),
      ev(BASE_BLOCK + 2, { decision: lateDecision(), quote: null }),
      ev(BASE_BLOCK + 3, { decision: { ...lateDecision(), late: false } }),
      ev(BASE_BLOCK + 4, { decision: decision("buy"), fill: fill({ side: "sell" }) }),
      ev(BASE_BLOCK + 5, { decision: decision("sell"), quote: quote({ status: "sent", orderId: null }) }),
      ev(BASE_BLOCK + 6, { decision: null, quote: null }),
    ];
    const { r } = chart(evs);
    const c = cells(r);
    expect(c.map((x) => x.getAttribute("fill"))).toEqual([
      "var(--buy-bar)",
      "var(--sell-bar)",
      "var(--late-cell)",
      "var(--hold-cell)",
      "var(--sell-bar)",
      "var(--sell-bar)",
      "var(--hold-cell)",
    ]);
    expect(c.map((x) => x.getAttribute("opacity"))).toEqual(["0.82", "0.82", "0.82", "0.82", "0.82", "0.6", "1"]);
    expect(c.at(-1)?.getAttribute("class")).toBe("cellPop");
    const glow = r.$("rect.cellGlow") as Element;
    expect(glow.getAttribute("fill")).toBe("var(--hold-cell)");
  });

  test("fills become beads on the line; the newest one pops with a riser and ripple", () => {
    const evs = blocks(10, BASE_BLOCK, (i) =>
      i === 3 ? { fill: fill({ side: "buy" }) } : i === 7 ? { fill: fill({ side: "sell", simulated: true, txHash: null }) } : {},
    );
    const { r } = chart(evs);
    const b = beads(r);
    expect(b.map((x) => x.getAttribute("fill"))).toEqual(["var(--buy)", "var(--sell)"]);
    expect(b.map((x) => x.getAttribute("class"))).toEqual([null, "beadPop"]);
    expect(b[1].getAttribute("cx")).toBe("70");
    const riser = r.$("line.riser") as Element;
    expect(riser.getAttribute("stroke")).toBe("var(--sell)");
    expect(riser.getAttribute("x1")).toBe("70");
    expect(riser.getAttribute("y1")).toBe(String(H - 40));
    expect(r.$("circle.ripple")?.getAttribute("stroke")).toBe("var(--sell)");
  });

  test("latest newer than the events tail is appended", () => {
    const evs = blocks(5);
    const newer = ev(BASE_BLOCK + 5, { decision: decision("sell") });
    const { r } = chart(evs, newer);
    expect(cells(r).length).toBe(6);
    expect(txt(r, ".tr .word")).toBe("Selling");
    expect(txt(r, ".tagText")).toBe(newer.mid.toFixed(6));
  });

  test("latest with no events at all is drawn alone", () => {
    const { r } = chart([], ev(BASE_BLOCK));
    expect(cells(r).length).toBe(1);
    expect(r.$("path.line")?.getAttribute("d")).toMatch(/^M\S+ \S+$/);
  });

  test("latest equal to the tail replaces it (a receipt or fill update)", () => {
    const evs = blocks(5);
    const updated = { ...evs[4], fill: fill({ side: "sell" }) };
    const { r } = chart(evs, updated);
    expect(cells(r).length).toBe(5);
    expect(beads(r).length).toBe(1);
  });

  test("latest older than the tail is ignored for the series but still drives the overlays", () => {
    const evs = blocks(5);
    const { r } = chart(evs, ev(BASE_BLOCK, { decision: decision("sell") }));
    expect(cells(r).length).toBe(5);
    expect(txt(r, ".tr .word")).toBe("Selling");
  });

  test("without latest the overlays follow the newest event", () => {
    const evs = blocks(3, BASE_BLOCK, (i) => (i === 2 ? { decision: decision("sell") } : {}));
    const { r } = chart(evs, null);
    expect(txt(r, ".tr .word")).toBe("Selling");
  });

  test("a flat price gets a 0.20% band centred on it", () => {
    const evs = blocks(10, BASE_BLOCK, () => ({ mid: 0.0225 }));
    const { r } = chart(evs);
    // lo/hi = 0.0225 -/+ 0.0000225; ticks at 75%, 50%, 25% of the band
    expect(ticks(r)).toEqual(["0.022511", "0.022500", "0.022489"]);
    // and the line is flat in the middle of the plot
    const midY = PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) / 2;
    expect(r.$("path.line")?.getAttribute("d")).toContain(`M0 ${midY}`);
  });

  test("the scale eases toward a new range instead of jumping", () => {
    const evs = blocks(10, BASE_BLOCK, () => ({ mid: 0.0225 }));
    const { r } = chart(evs);
    const before = ticks(r);
    // a big jump: the band must grow at once to contain it ...
    const jumped = [...evs, ev(BASE_BLOCK + 10, { mid: 0.0235 })];
    r.rerender(<FlowChart events={jumped} latest={jumped.at(-1)!} />);
    const after = ticks(r);
    expect(after).not.toEqual(before);
    // the top tick is near the new high: lo + 0.75 * range, range contains 0.0225..0.0235
    expect(Number(after[0])).toBeGreaterThan(0.0232);
    // ... and shrink slowly once the spike scrolls out (eased 10% per block)
    let cur = jumped;
    for (let i = 0; i < 80; i++) cur = [...cur, ev(BASE_BLOCK + 11 + i, { mid: 0.0225 })];
    r.rerender(<FlowChart events={cur} latest={cur.at(-1)!} />);
    const once = Number(ticks(r)[0]);
    expect(once).toBeGreaterThan(0.0225 + 0.0000225); // one easing step: still far wider than the floor
    cur = [...cur, ev(BASE_BLOCK + 91, { mid: 0.0225 })];
    r.rerender(<FlowChart events={cur} latest={cur.at(-1)!} />);
    expect(Number(ticks(r)[0])).toBeLessThan(once);
  });

  test("a re-render for the same block (resize, receipt) keeps the scale", () => {
    const evs = blocks(20);
    const { r, ro } = chart(evs);
    const before = ticks(r);
    ro.resize(W + 40, H);
    expect(ticks(r)).toEqual(before);
    const updated = { ...evs.at(-1)!, quote: quote({ status: "placed" }) };
    r.rerender(<FlowChart events={evs} latest={updated} />);
    expect(ticks(r)).toEqual(before);
  });

  test("a narrow band below the floor is re-centred after easing", () => {
    const flat = blocks(10, BASE_BLOCK, () => ({ mid: 0.0225 }));
    const { r } = chart(flat);
    // a slightly higher price raises the 0.20% floor; the eased band is now narrower than it
    const next = [...flat, ev(BASE_BLOCK + 10, { mid: 0.02251 })];
    r.rerender(<FlowChart events={next} latest={next.at(-1)!} />);
    const [top, mid, bottom] = ticks(r).map(Number);
    // the band is exactly the new floor (0.20% of the mean), so the 25%..75% ticks span half of it
    expect(top - bottom).toBeCloseTo(0.002 * 0.0225 * 0.5, 5);
    expect(mid).toBeGreaterThanOrEqual(0.0225);
    expect(mid).toBeLessThan(0.02251);
  });

  test("resize to the same size (within half a pixel) is a no-op", () => {
    const { r, ro } = chart(blocks(5));
    const html = r.html();
    ro.resize(W + 0.3, H - 0.4);
    expect(r.html()).toBe(html);
    expect(r.$("svg")?.getAttribute("viewBox")).toBe(`0 0 ${W} ${H}`);
  });

  test("unmount disconnects the ResizeObserver", () => {
    const { r, ro } = chart(blocks(5));
    r.unmount();
    expect(ro.disconnected).toBe(true);
  });

  describe("hover tooltip", () => {
    const last = BASE_BLOCK + 29;

    function hoverChart() {
      const evs = blocks(30, BASE_BLOCK, (i) => {
        if (i === 5) return { fill: fill({ side: "buy" }) };
        if (i === 6) return { fill: fill({ side: "sell" }) };
        if (i === 7) return { decision: decision("sell", 0.6, 120), quote: quote({ side: "sell", price: 0.022651 }) };
        if (i === 8) return { decision: lateDecision(), quote: null };
        if (i === 9) return { quote: null };
        return {};
      });
      return { evs, ...chart(evs) };
    }

    test("a mouse over a fill shows FILL side and size", () => {
      const { r, evs } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 5));
      expect(tip(r)).toMatchObject({
        block: `#${BASE_BLOCK + 5}`,
        price: evs[5].mid.toFixed(6),
        trade: "FILL BUY 200 MON",
        tint: "var(--buy-ink)",
        lat: "81 ms",
      });
      expect(r.$("line.cross")).not.toBeNull();
      expect(r.$("circle.crossDot")?.getAttribute("cx")).toBe("50");
      hover(r, xFor(last, BASE_BLOCK + 6));
      expect(tip(r)).toMatchObject({ trade: "FILL SELL 200 MON", tint: "var(--sell-ink)" });
    });

    test("a quote shows bid/ask and price; a late block shows 'late'; no quote is muted", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK));
      expect(tip(r)).toMatchObject({ trade: "bid 0.022629", tint: "var(--buy-ink)" });
      hover(r, xFor(last, BASE_BLOCK + 7));
      expect(tip(r)).toMatchObject({ trade: "ask 0.022651", tint: "var(--sell-ink)", lat: "120 ms" });
      hover(r, xFor(last, BASE_BLOCK + 8));
      expect(tip(r)).toMatchObject({ trade: "no quote", tint: "var(--muted)", lat: "late" });
      hover(r, xFor(last, BASE_BLOCK + 9));
      expect(tip(r)).toMatchObject({ trade: "no quote", lat: "81 ms" });
    });

    test("the tooltip flips to the left near the right edge", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 9));
      expect(tip(r)?.transform).toMatch(/^translate\(104\.0,/); // x + 14
      hover(r, xFor(last, last));
      expect(tip(r)?.transform).toMatch(/^translate\(144\.0,/); // x - 146
    });

    test("the tooltip stays inside the plot vertically", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 3));
      const ty = Number(/,(-?[\d.]+)\)$/.exec(tip(r)!.transform)![1]);
      expect(ty).toBeGreaterThanOrEqual(PAD_TOP - 46);
      expect(ty).toBeLessThanOrEqual(H - PAD_BOTTOM - 82);
    });

    test("touch and pen do not hover", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 5), "touch");
      expect(tip(r)).toBeNull();
      hover(r, xFor(last, BASE_BLOCK + 5), "pen");
      expect(tip(r)).toBeNull();
    });

    test("outside the series (left of the first block, or right of the last) nothing shows", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK - 3));
      expect(tip(r)).toBeNull();
      hover(r, xFor(last, last + 3));
      expect(tip(r)).toBeNull();
    });

    test("leaving the panel hides the tooltip", () => {
      const { r } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 5));
      expect(tip(r)).not.toBeNull();
      pointer(r, "pointerout", { pointerType: "mouse", relatedTarget: document.body });
      expect(tip(r)).toBeNull();
    });

    test("no hover before the chart has a size", () => {
      const { r } = chart(blocks(5), undefined, null);
      hover(r, 100);
      expect(tip(r)).toBeNull();
    });

    // Regression: the tooltip used 0 decimals, so a 0.35 MON partial fill read "FILL BUY 0 MON".
    test("a partial fill under 1 MON shows its real size in the tooltip", () => {
      const evs = blocks(10, BASE_BLOCK, (i) => (i === 4 ? { fill: fill({ side: "buy", size: 0.35 }) } : {}));
      const { r } = chart(evs);
      hover(r, xFor(BASE_BLOCK + 9, BASE_BLOCK + 4));
      expect(tip(r)?.trade).toMatch(/0\.35/);
    });

    test("a hovered block that scrolls out of the data drops the tooltip", () => {
      const { r, evs } = hoverChart();
      hover(r, xFor(last, BASE_BLOCK + 5));
      expect(tip(r)).not.toBeNull();
      const later = blocks(30, BASE_BLOCK + 100);
      r.rerender(<FlowChart events={later} latest={later.at(-1)!} />);
      expect(tip(r)).toBeNull();
      expect(evs.length).toBe(30);
    });
  });
});
