import { afterEach, describe, expect, test } from "bun:test";
import DecisionPanel from "../src/components/DecisionPanel/DecisionPanel";
import type { BlockEvent } from "../src/lib/types";
import { WEB, cleanup, decision, ev, lateDecision, quote, render } from "./helpers";

function view(latest: BlockEvent | null) {
  const m = render(<DecisionPanel latest={latest} />);
  const rows = m.$$(".row").map((r) => {
    const label = r.querySelector(".label") as HTMLElement;
    const fill = r.querySelector(".fill") as HTMLElement;
    return {
      label: label.textContent,
      color: label.style.color,
      opacity: label.style.opacity,
      width: fill.style.width,
      background: fill.style.background,
      pct: r.querySelector(".pct")?.textContent,
    };
  });
  const headline = m.$(".headline") as HTMLElement;
  return {
    m,
    rows,
    word: m.$(".headlineWord")?.textContent,
    pct: m.$(".headlinePct")?.textContent ?? null,
    color: headline.style.color,
  };
}

describe.skipIf(!WEB)("DecisionPanel", () => {
  afterEach(cleanup);

  test("always shows the standing order and the question", () => {
    const { m } = view(ev());
    expect(m.text()).toContain("STANDING ORDER");
    expect(m.text()).toContain("> evaluate Kuru's MON/USDC book every block. quote when edge and risk checks pass.");
    expect(m.text()).toContain("WHICH SIDE THIS BLOCK?");
  });

  test("buy: BUY with the buy probability, buy bar active", () => {
    const v = view(ev(1, { decision: decision("buy", 0.77) }));
    expect(v.word).toBe("BUY");
    expect(v.pct).toBe("77%");
    expect(v.color).toBe("var(--buy-ink)");
    expect(v.rows).toEqual([
      { label: "buy", color: "var(--buy-ink)", opacity: "1", width: "77%", background: "var(--buy-bar)", pct: "77%" },
      { label: "sell", color: "var(--sell-ink)", opacity: "0.38", width: "23%", background: "var(--sell-bar-dim)", pct: "23%" },
    ]);
  });

  test("sell: SELL with the sell probability, sell bar active", () => {
    const v = view(ev(1, { decision: decision("sell", 0.64) }));
    expect(v.word).toBe("SELL");
    expect(v.pct).toBe("64%");
    expect(v.color).toBe("var(--sell-ink)");
    expect(v.rows[0]).toMatchObject({ opacity: "0.38", width: "36%", background: "var(--buy-bar-dim)", pct: "36%" });
    expect(v.rows[1]).toMatchObject({ opacity: "1", width: "64%", background: "var(--sell-bar)", pct: "64%" });
  });

  test("capped quote: the headline is the side that was posted, the bars keep the model's call", () => {
    // The backend rewrites action to the side it could post; probabilities stay the model's.
    const d = { ...decision("buy", 0.77), action: "sell" as const };
    const v = view(ev(1, { decision: d, quote: quote({ side: "sell", capped: true }) }));
    expect(v.word).toBe("SELL");
    expect(v.pct).toBe("23%");
    expect(v.rows[0].pct).toBe("77%");
    expect(v.rows[1].pct).toBe("23%");
  });

  test("late block: LATE, no percentages, empty dim bars", () => {
    const v = view(ev(1, { decision: lateDecision(), quote: null }));
    expect(v.word).toBe("LATE");
    expect(v.pct).toBeNull();
    expect(v.color).toBe("var(--late-ink)");
    for (const r of v.rows) {
      expect(r.pct).toBe("-");
      expect(r.opacity).toBe("0.38");
      expect(r.width).toBe("0%");
    }
  });

  test("a non-late hold is a deliberate skip", () => {
    const v = view(ev(1, { decision: { ...lateDecision(), late: false } }));
    expect(v.word).toBe("SKIP");
    expect(v.rows.map((r) => r.pct)).toEqual(["-", "-"]);
  });

  test("a block with no decision object reads LATE", () => {
    const v = view(ev(1, { decision: null }));
    expect(v.word).toBe("LATE");
    expect(v.rows.map((r) => r.width)).toEqual(["0%", "0%"]);
  });

  test("no data yet: bars are empty and show '-'", () => {
    const v = view(null);
    expect(v.rows.map((r) => r.pct)).toEqual(["-", "-"]);
    expect(v.rows.map((r) => r.width)).toEqual(["0%", "0%"]);
    expect(v.pct).toBeNull();
  });

  // Regression: before the first block it used to say LATE in the late colour, while the chart
  // said "waiting for blocks" and the feed "no blocks yet".
  test("no data yet: the headline does not claim the block was missed", () => {
    const v = view(null);
    expect(v.word).not.toBe("LATE");
  });

  test("probabilities outside 0..1 are clamped in the bar width", () => {
    const d = { ...decision("buy"), probabilities: { buy: 1.4, sell: -0.4, hold: 0 } };
    const v = view(ev(1, { decision: d }));
    expect(v.rows[0].width).toBe("100%");
    expect(v.rows[1].width).toBe("0%");
    expect(v.rows[0].pct).toBe("140%");
  });
});
