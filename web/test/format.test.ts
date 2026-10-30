import { describe, expect, test } from "bun:test";
import {
  fmtConf,
  fmtInt,
  fmtMon,
  fmtMs,
  fmtPct,
  fmtPrice,
  fmtSigned,
  fmtSignedMon,
  fmtSignedPct,
  fmtUsd,
  hhmmss,
  shortAddr,
  shortTx,
  txUrl,
  uptime,
} from "../src/lib/format";
import { WEB } from "./helpers";

const JUNK = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const;

describe.skipIf(!WEB)("lib/format", () => {
  test("fmtInt groups thousands and rounds", () => {
    expect(fmtInt(105416201)).toBe("105,416,201");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(999)).toBe("999");
    expect(fmtInt(1234.5)).toBe("1,235");
    expect(fmtInt(1234.49)).toBe("1,234");
    expect(fmtInt(-1234.4)).toBe("-1,234");
    for (const j of JUNK) expect(fmtInt(j)).toBe("0");
  });

  // Regression: Intl keeps the sign of -0, while fmtMs/fmtPct (template strings) print "0".
  test("fmtInt never renders a negative zero (-0.4 -> \"0\")", () => {
    expect(fmtInt(-0.4)).toBe("0");
  });

  test("fmtPrice is always 6 decimals", () => {
    expect(fmtPrice(0.0222354)).toBe("0.022235");
    expect(fmtPrice(0.022636)).toBe("0.022636");
    expect(fmtPrice(1)).toBe("1.000000");
    expect(fmtPrice(-0.5)).toBe("-0.500000");
    for (const j of JUNK) expect(fmtPrice(j)).toBe("0.000000");
  });

  test("fmtUsd puts the sign before the dollar", () => {
    expect(fmtUsd(0.0045)).toBe("$0.0045");
    expect(fmtUsd(-0.0045)).toBe("-$0.0045");
    expect(fmtUsd(12.3456789, 2)).toBe("$12.35");
    expect(fmtUsd(-12.3456789, 2)).toBe("-$12.35");
    expect(fmtUsd(0)).toBe("$0.0000");
    for (const j of JUNK) expect(fmtUsd(j)).toBe("$0.0000");
  });

  test("fmtMon", () => {
    expect(fmtMon(0.0213)).toBe("0.021 MON");
    expect(fmtMon(200, 0)).toBe("200 MON");
    expect(fmtMon(-1.23456, 2)).toBe("-1.23 MON");
    for (const j of JUNK) expect(fmtMon(j)).toBe("0.000 MON");
  });

  test("fmtPct takes a ratio and rounds to a whole percent", () => {
    expect(fmtPct(0.62)).toBe("62%");
    expect(fmtPct(1)).toBe("100%");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(0.005)).toBe("1%");
    expect(fmtPct(-0.25)).toBe("-25%");
    expect(fmtPct(-0.004)).toBe("0%"); // -0 prints as "0" in a template string
    for (const j of JUNK) expect(fmtPct(j)).toBe("0%");
  });

  test("fmtConf is two decimals", () => {
    expect(fmtConf(0.62)).toBe("0.62");
    expect(fmtConf(1)).toBe("1.00");
    expect(fmtConf(0.777)).toBe("0.78");
    for (const j of JUNK) expect(fmtConf(j)).toBe("0.00");
  });

  test("fmtSigned always shows a sign", () => {
    expect(fmtSigned(0.003)).toBe("+0.003");
    expect(fmtSigned(-0.003)).toBe("-0.003");
    expect(fmtSigned(0)).toBe("+0.000");
    expect(fmtSigned(-0)).toBe("+0.000");
    expect(fmtSigned(1.23456, 2)).toBe("+1.23");
    expect(fmtSigned(-1.23456, 2)).toBe("-1.23");
    // a tiny loss keeps its minus sign even when it rounds to zero
    expect(fmtSigned(-0.0004)).toBe("-0.000");
    for (const j of JUNK) expect(fmtSigned(j)).toBe("+0.000");
  });

  test("fmtSignedMon", () => {
    expect(fmtSignedMon(-0.0012)).toBe("-0.001 MON");
    expect(fmtSignedMon(0.003)).toBe("+0.003 MON");
    expect(fmtSignedMon(-0.13, 2)).toBe("-0.13 MON");
    for (const j of JUNK) expect(fmtSignedMon(j)).toBe("+0.000 MON");
  });

  test("fmtSignedPct takes a ratio", () => {
    expect(fmtSignedPct(0.0012)).toBe("+0.12%");
    expect(fmtSignedPct(-0.0012)).toBe("-0.12%");
    expect(fmtSignedPct(0)).toBe("+0.00%");
    expect(fmtSignedPct(0.5, 0)).toBe("+50%");
    for (const j of JUNK) expect(fmtSignedPct(j)).toBe("+0.00%");
  });

  test("fmtMs rounds", () => {
    expect(fmtMs(107)).toBe("107 ms");
    expect(fmtMs(80.6)).toBe("81 ms");
    expect(fmtMs(-0.4)).toBe("0 ms");
    for (const j of JUNK) expect(fmtMs(j)).toBe("0 ms");
  });

  describe("uptime", () => {
    const now = Date.UTC(2026, 9, 29, 16, 13, 42); // 1.79e12 ms
    const start = Date.UTC(2026, 9, 29, 12, 0, 0);

    test("ms epoch", () => {
      expect(uptime(start, now)).toBe("04:13:42");
    });

    test("seconds epoch is detected and scaled", () => {
      expect(uptime(start / 1000, now)).toBe("04:13:42");
      expect(uptime(Math.floor(start / 1000) + 0.9, now)).toBe("04:13:41");
    });

    test("the seconds/ms threshold sits at 1e12", () => {
      // 1e12 - 1 is read as seconds (year ~33658), so it is in the future: clamped to zero
      expect(uptime(1e12 - 1, now)).toBe("00:00:00");
      // 1e12 is read as ms (2001-09-09)
      expect(uptime(1e12, 1e12 + 3_600_000)).toBe("01:00:00");
    });

    test("missing, zero and non-finite start render zeros", () => {
      for (const j of [...JUNK, 0]) expect(uptime(j, now)).toBe("00:00:00");
    });

    test("a start in the future clamps to zero", () => {
      expect(uptime(now + 5_000, now)).toBe("00:00:00");
    });

    test("hours are not capped at 24", () => {
      expect(uptime(start, start + 100 * 3_600_000 + 61_000)).toBe("100:01:01");
    });

    test("defaults `now` to Date.now()", () => {
      expect(uptime(Date.now() - 3_723_000)).toBe("01:02:03");
    });
  });

  describe("hhmmss", () => {
    test("pads and floors", () => {
      expect(hhmmss(0)).toBe("00:00:00");
      expect(hhmmss(999)).toBe("00:00:00");
      expect(hhmmss(1000)).toBe("00:00:01");
      expect(hhmmss(59_999)).toBe("00:00:59");
      expect(hhmmss(60_000)).toBe("00:01:00");
      expect(hhmmss(3_599_999)).toBe("00:59:59");
      expect(hhmmss(3_600_000)).toBe("01:00:00");
      expect(hhmmss(36_000_000)).toBe("10:00:00");
      expect(hhmmss(360_000_000)).toBe("100:00:00");
    });

    test("negative clamps to zero", () => {
      expect(hhmmss(-5_000)).toBe("00:00:00");
    });

    // Regression: every other helper sanitized non-finite input, hhmmss did not.
    test("non-finite input renders zeros instead of NaN:NaN:NaN", () => {
      expect(hhmmss(Number.NaN)).toBe("00:00:00");
      expect(hhmmss(Number.POSITIVE_INFINITY)).toBe("00:00:00");
    });
  });

  test("shortAddr keeps 0x + 4 and the last 4", () => {
    expect(shortAddr("0x7F3a1b2c3d4e5f60718293a4b5c6d7e8f9019C4e")).toBe("0x7F3a…9C4e");
    expect(shortAddr("")).toBe("");
    expect(shortAddr(null)).toBe("");
    expect(shortAddr(undefined)).toBe("");
    expect(shortAddr("0x12")).toBe("0x12");
    expect(shortAddr("0x1234567890")).toBe("0x1234567890"); // 12 chars: unchanged
    expect(shortAddr("0x12345678901")).toBe("0x1234…8901"); // 13 chars: shortened
  });

  test("shortTx keeps 0x + 4", () => {
    expect(shortTx("0x8f2c4e6a1b3d")).toBe("0x8f2c…");
    expect(shortTx("0x8f2c")).toBe("0x8f2c"); // 6 chars: unchanged
    expect(shortTx("0x8f2c4")).toBe("0x8f2c…");
    expect(shortTx("0x")).toBe("0x");
    expect(shortTx("")).toBe("");
    expect(shortTx(null)).toBe("");
    expect(shortTx(undefined)).toBe("");
  });

  test("txUrl points at monadvision", () => {
    expect(txUrl("0xabc")).toBe("https://monadvision.com/tx/0xabc");
  });

  test("no helper emits a banned dash or middle dot", () => {
    const outs = [
      fmtInt(-5),
      fmtPrice(-1),
      fmtUsd(-1),
      fmtMon(-1),
      fmtPct(-1),
      fmtConf(-1),
      fmtSigned(-1),
      fmtSignedMon(-1),
      fmtSignedPct(-1),
      fmtMs(-1),
      uptime(1),
      hhmmss(1),
      shortAddr("0x7F3a1b2c3d4e5f60718293a4b5c6d7e8f9019C4e"),
      shortTx("0x8f2c4e6a"),
    ];
    for (const s of outs) expect(s).not.toMatch(/[·—–]/);
  });
});
