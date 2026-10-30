import { describe, expect, test } from "bun:test";
import { smoothPath } from "../src/components/FlowChart/smooth";
import { WEB } from "./helpers";

type Pt = readonly [number, number];
interface Seg {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p1: Pt;
}

/** Parses "Mx yCx y x y x y..." into cubic segments. */
function parse(d: string): { start: Pt; segs: Seg[] } {
  const tokens = d.match(/[MC]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN|-?Infinity/g) ?? [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  expect(tokens[i++]).toBe("M");
  const start: Pt = [num(), num()];
  const segs: Seg[] = [];
  let p0 = start;
  while (i < tokens.length) {
    expect(tokens[i++]).toBe("C");
    const c1: Pt = [num(), num()];
    const c2: Pt = [num(), num()];
    const p1: Pt = [num(), num()];
    segs.push({ p0, c1, c2, p1 });
    p0 = p1;
  }
  return { start, segs };
}

function bezier(s: Seg, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return [
    a * s.p0[0] + b * s.c1[0] + c * s.c2[0] + e * s.p1[0],
    a * s.p0[1] + b * s.c1[1] + c * s.c2[1] + e * s.p1[1],
  ];
}

/** Every coordinate is rounded to 0.1, so allow one rounding step. */
const EPS = 0.1 + 1e-9;

function assertNoOvershoot(pts: Pt[]) {
  const { start, segs } = parse(smoothPath(pts));
  expect(start[0]).toBeCloseTo(pts[0][0], 1);
  expect(segs.length).toBe(pts.length - 1);
  segs.forEach((s, i) => {
    const [a, b] = [pts[i], pts[i + 1]];
    const lo = Math.min(a[1], b[1]) - EPS;
    const hi = Math.max(a[1], b[1]) + EPS;
    // control points stay inside the segment's box, so the curve (their convex hull) does too
    for (const c of [s.c1, s.c2]) {
      expect(c[1]).toBeGreaterThanOrEqual(lo);
      expect(c[1]).toBeLessThanOrEqual(hi);
      expect(c[0]).toBeGreaterThanOrEqual(Math.min(a[0], b[0]) - EPS);
      expect(c[0]).toBeLessThanOrEqual(Math.max(a[0], b[0]) + EPS);
    }
    for (let t = 0; t <= 1; t += 0.05) {
      const [, y] = bezier(s, t);
      expect(y).toBeGreaterThanOrEqual(lo);
      expect(y).toBeLessThanOrEqual(hi);
    }
    expect(s.p1[0]).toBeCloseTo(b[0], 1);
    expect(s.p1[1]).toBeCloseTo(b[1], 1);
  });
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!WEB)("FlowChart/smooth", () => {
  test("0 points is an empty path", () => {
    expect(smoothPath([])).toBe("");
  });

  test("1 point is a bare move, rounded to 0.1", () => {
    expect(smoothPath([[1.234, 5.678]])).toBe("M1.2 5.7");
    expect(smoothPath([[-1.26, 0]])).toBe("M-1.3 0");
  });

  test("2 points is a straight cubic with controls at the thirds", () => {
    expect(smoothPath([[0, 0], [30, 60]])).toBe("M0 0C10 20 20 40 30 60");
    expect(smoothPath([[0, 60], [30, 0]])).toBe("M0 60C10 40 20 20 30 0");
  });

  test("a straight line stays straight through interior points", () => {
    const { segs } = parse(smoothPath([[0, 0], [10, 10], [20, 20], [30, 30]]));
    for (const s of segs) {
      expect(s.c1[1] - s.p0[1]).toBeCloseTo(s.c1[0] - s.p0[0], 5);
      expect(s.p1[1] - s.c2[1]).toBeCloseTo(s.p1[0] - s.c2[0], 5);
    }
  });

  test("a flat run is drawn flat", () => {
    const d = smoothPath([[0, 50], [10, 50], [20, 50], [30, 50]]);
    expect(d).toBe("M0 50C3.3 50 6.7 50 10 50C13.3 50 16.7 50 20 50C23.3 50 26.7 50 30 50");
  });

  test("a flat segment between moves gets zero tangents at both ends", () => {
    const { segs } = parse(smoothPath([[0, 0], [10, 20], [20, 20], [30, 40]]));
    // the flat segment's controls sit on the line
    expect(segs[1].c1[1]).toBe(20);
    expect(segs[1].c2[1]).toBe(20);
    // and the neighbours arrive / leave horizontally
    expect(segs[0].c2[1]).toBe(20);
    expect(segs[2].c1[1]).toBe(20);
  });

  test("a local extremum (sign change) gets a horizontal tangent", () => {
    const { segs } = parse(smoothPath([[0, 0], [10, 30], [20, 0], [30, 30], [40, 0]]));
    expect(segs[0].c2[1]).toBe(30);
    expect(segs[1].c1[1]).toBe(30);
    expect(segs[1].c2[1]).toBe(0);
    expect(segs[2].c1[1]).toBe(0);
  });

  test("interior tangents are continuous (C1) on an even grid", () => {
    const pts: Pt[] = [[0, 10], [10, 14], [20, 30], [30, 31], [40, 60]];
    const { segs } = parse(smoothPath(pts));
    for (let i = 0; i < segs.length - 1; i++) {
      const inSlope = (segs[i].p1[1] - segs[i].c2[1]) / (segs[i].p1[0] - segs[i].c2[0]);
      const outSlope = (segs[i + 1].c1[1] - segs[i + 1].p0[1]) / (segs[i + 1].c1[0] - segs[i + 1].p0[0]);
      expect(Math.abs(inSlope - outSlope)).toBeLessThan(0.05);
    }
  });

  test("uneven spacing uses the weighted harmonic mean (Fritsch-Butland)", () => {
    // slopes 1 (h=10) and 4 (h=30): w1 = 2*30+10 = 70, w2 = 30+20 = 50 -> t = 120 / (70/1 + 50/4) = 1.4545...
    const { segs } = parse(smoothPath([[0, 0], [10, 10], [40, 130]]));
    const t = 120 / (70 + 12.5);
    expect(segs[0].c2[1]).toBeCloseTo(10 - (t * 10) / 3, 1);
    expect(segs[1].c1[1]).toBeCloseTo(10 + (t * 30) / 3, 1);
  });

  test("duplicate x values do not produce NaN or Infinity", () => {
    for (const pts of [
      [[0, 0], [10, 10], [10, 20], [20, 30]],
      [[0, 0], [0, 10], [10, 20]],
      [[0, 0], [10, 10], [20, 20], [20, 5]],
      [[5, 5], [5, 5], [5, 5]],
    ] as Pt[][]) {
      const d = smoothPath(pts);
      expect(d).not.toMatch(/NaN|Infinity/);
      expect(parse(d).segs.length).toBe(pts.length - 1);
    }
  });

  test("a vertical jump at a duplicate x is a straight vertical segment", () => {
    const { segs } = parse(smoothPath([[0, 0], [10, 10], [10, 20], [20, 30]]));
    expect(segs[1].c1[0]).toBe(10);
    expect(segs[1].c2[0]).toBe(10);
    expect(segs[1].p1).toEqual([10, 20]);
  });

  test("non-finite tangents fall back to 0 instead of poisoning the path", () => {
    // A NaN y gives NaN slopes; the interior tangents next to it are clamped to 0.
    const d = smoothPath([[0, 0], [10, 10], [20, Number.NaN], [30, 30], [40, 40]]);
    const { segs } = parse(d);
    expect(segs[0].c1[1]).toBe(3.3);
    expect(segs[0].c2[1]).toBe(10); // tangent at the point before the NaN is 0
  });

  test("never overshoots its data (handcrafted spikes and steps)", () => {
    assertNoOvershoot([[0, 0], [10, 100], [20, 0]]);
    assertNoOvershoot([[0, 0], [10, 0], [20, 100], [30, 100]]);
    assertNoOvershoot([[0, 0], [1, 100], [100, 101], [101, 200]]);
    assertNoOvershoot([[0, 300], [10, 299.9], [20, 100], [30, 99.9], [40, 0]]);
    assertNoOvershoot([[0, 0], [10, 1], [20, 1000], [30, 1001]]);
  });

  test("never overshoots its data (randomized, 300 series)", () => {
    const rand = rng(42);
    for (let k = 0; k < 300; k++) {
      const n = 2 + Math.floor(rand() * 60);
      const pts: Pt[] = [];
      let x = rand() * 50 - 25;
      let y = rand() * 400;
      for (let i = 0; i < n; i++) {
        pts.push([x, y]);
        const r = rand();
        x += r < 0.05 ? 0 : r < 0.5 ? 10 : rand() * 40; // duplicates, even steps, ragged steps
        const s = rand();
        y = s < 0.15 ? y : s < 0.3 ? y + (rand() - 0.5) * 400 : y + (rand() - 0.5) * 20; // flats, spikes, noise
      }
      assertNoOvershoot(pts);
    }
  });

  test("the chart's real shape: a price series in pixel space", () => {
    const mids = [0.022636, 0.02264, 0.022628, 0.022628, 0.022651, 0.022649, 0.02262];
    const lo = Math.min(...mids);
    const hi = Math.max(...mids);
    const pts = mids.map((m, i) => [i * 10, 84 + (1 - (m - lo) / (hi - lo)) * 300] as Pt);
    assertNoOvershoot(pts);
  });
});
