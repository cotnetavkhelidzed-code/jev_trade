import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import {
  SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS, abiBytesPayload, ammLevels, buildBook, decodeL2Book, decodeVaultParams,
  formatLevels, log10, readBook, readVaultParams, toFloat, vaultActive, type VaultParams,
} from "../src/book";
import { PARAMS, encodeL2, encodeVault, mockRpc, obIface } from "./helpers";
import fixture from "./fixtures/mainnet-2026-10-29.json";

const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";

// Deterministic PRNG so property tests are reproducible.
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("selectors", () => {
  test("match the Kuru OrderBook ABI", () => {
    expect(SEL_GET_L2_BOOK).toBe(obIface.getSighash("getL2Book"));
    expect(SEL_GET_VAULT_PARAMS).toBe(obIface.getSighash("getVaultParams"));
  });
});

describe("toFloat", () => {
  test("equals parseFloat(ethers.utils.formatUnits(x, d)) for random values and decimals", () => {
    const r = rng(1);
    for (let i = 0; i < 3000; i++) {
      const digits = 1 + Math.floor(r() * 40);
      let s = String(1 + Math.floor(r() * 9));
      for (let j = 1; j < digits; j++) s += Math.floor(r() * 10);
      const x = BigInt(s), d = Math.floor(r() * 24);
      expect(toFloat(x, d)).toBe(parseFloat(ethers.utils.formatUnits(x, d)));
      expect(toFloat(-x, d)).toBe(parseFloat(ethers.utils.formatUnits(-x, d)));
    }
  });
  test("edge cases", () => {
    expect(toFloat(0n, 18)).toBe(0);
    expect(toFloat(5n, 0)).toBe(5);
    expect(toFloat(-5n, 0)).toBe(-5);
    expect(toFloat(1n, 18)).toBe(1e-18); // shorter than the decimals: zero-padded
    expect(toFloat(2408100n, 8)).toBe(0.024081);
    expect(toFloat(1999891806819n, 10)).toBe(199.9891806819);
  });
});

describe("log10", () => {
  test("is the digit count minus one of a power of ten", () => {
    expect(log10(PARAMS.pricePrecision)).toBe(8);
    expect(log10(PARAMS.sizePrecision)).toBe(10);
    expect(log10(PARAMS.tickSize)).toBe(2);
    expect(log10({ toString: () => "1" })).toBe(0);
  });
});

describe("abiBytesPayload", () => {
  test("unwraps ABI-encoded bytes with or without 0x", () => {
    const enc = ethers.utils.defaultAbiCoder.encode(["bytes"], ["0xdeadbeef"]);
    expect(abiBytesPayload(enc)).toBe("0xdeadbeef");
    expect(abiBytesPayload(enc.slice(2))).toBe("0xdeadbeef");
    expect(abiBytesPayload(ethers.utils.defaultAbiCoder.encode(["bytes"], ["0x"]))).toBe("0x");
  });
});

describe("decodeL2Book", () => {
  test("decodes the real mainnet book (no bids, seven asks, best first)", () => {
    const l2 = decodeL2Book(fixture.getL2Book, 8, 10);
    expect(l2.block).toBeGreaterThan(117_000_000);
    expect(l2.bids).toEqual([]);
    expect(l2.asks).toEqual([[0.024081, 199.9891806819], [0.02439, 200], [0.025664, 400], [0.026404, 216.774587], [0.0347, 200000], [0.036883, 25000], [0.04, 3390]]);
  });
  test("decodes both sides of a synthetic book in on-chain order", () => {
    const hex = encodeL2(123, [[0.0236, 500], [0.023598, 1000.5]], [[0.023605, 200], [0.02361, 300]]);
    expect(decodeL2Book(hex, 8, 10)).toEqual({ block: 123, bids: [[0.0236, 500], [0.023598, 1000.5]], asks: [[0.023605, 200], [0.02361, 300]] });
  });
  test("an empty book", () => {
    expect(decodeL2Book(encodeL2(9, [], []), 8, 10)).toEqual({ block: 9, bids: [], asks: [] });
  });
});

describe("vault params", () => {
  test("decodes the real mainnet vault (inactive: zero order sizes)", () => {
    const v = decodeVaultParams(fixture.getVaultParams);
    expect(v.kuruAmmVault).toBe("0x838c2d3fd4db5eb2f185cbe7697fbaace52b34d7");
    expect(v.vaultBidOrderSize).toBe(0n);
    expect(v.vaultAskOrderSize).toBe(0n);
    expect(v.spread).toBe(30n);
    expect(vaultActive(v)).toBe(false);
  });
  test("decodes every field in order, with or without 0x, the same as the ABI", () => {
    const hex = encodeVault({ bestBid: 11n, bidPartial: 22n, bestAsk: 33n, askPartial: 44n, bidSize: 55n, askSize: 66n, spread: 77n });
    const want = { kuruAmmVault: "0x838c2d3fd4db5eb2f185cbe7697fbaace52b34d7", vaultBestBid: 11n, bidPartiallyFilledSize: 22n, vaultBestAsk: 33n, askPartiallyFilledSize: 44n, vaultBidOrderSize: 55n, vaultAskOrderSize: 66n, spread: 77n };
    expect(decodeVaultParams(hex)).toEqual(want);
    expect(decodeVaultParams(hex.slice(2))).toEqual(want);
  });
  test("vaultActive needs a bid size and a non-zero vault address", () => {
    const base = decodeVaultParams(encodeVault({ bestBid: 1n, bestAsk: 2n, bidSize: 5n, askSize: 5n, spread: 30n }));
    expect(vaultActive(base)).toBe(true);
    expect(vaultActive({ ...base, vaultBidOrderSize: 0n })).toBe(false);
    expect(vaultActive({ ...base, kuruAmmVault: "0x0000000000000000000000000000000000000000" })).toBe(false);
  });
});

describe("ammLevels", () => {
  const active: VaultParams = { kuruAmmVault: "0x838c2d3fd4db5eb2f185cbe7697fbaace52b34d7", vaultBestBid: 23_600_000_000_000_000n, bidPartiallyFilledSize: 1_000_000_000n, vaultBestAsk: 23_700_000_000_000_000n, askPartiallyFilledSize: 0n, vaultBidOrderSize: 5_000_000_000_000n, vaultAskOrderSize: 4_000_000_000_000n, spread: 30n };
  test("inactive vault: no levels", () => {
    expect(ammLevels({ ...active, vaultBidOrderSize: 0n }, 10)).toEqual({ bids: [], asks: [] });
  });
  test("300 levels a side: first level net of the partial fill, then geometric steps", () => {
    const { bids, asks } = ammLevels(active, 10);
    expect(bids.length).toBe(300);
    expect(asks.length).toBe(300);
    expect(bids[0]).toEqual([0.0236, 499.9]);
    expect(asks[0]).toEqual([0.0237, 400]);
    for (let i = 1; i < 300; i++) { expect(bids[i]![0]).toBeLessThan(bids[i - 1]![0]); expect(asks[i]![0]).toBeGreaterThan(asks[i - 1]![0]); }
  });
  test("stops at a zero bid price and at a max-uint ask price", () => {
    const { bids, asks } = ammLevels({ ...active, vaultBestBid: 0n, vaultBestAsk: (1n << 256n) - 1n }, 10);
    expect(bids).toEqual([]);
    expect(asks).toEqual([]);
  });
  test("bids that round down to zero stop early", () => {
    // spread 30000 -> sc 3000: 1 wei * 1000 / 4000 rounds to 0 after the first level
    const { bids } = ammLevels({ ...active, vaultBestBid: 1n, spread: 30_000n }, 10);
    expect(bids).toEqual([[1e-18, 499.9]]);
  });
});

describe("buildBook and formatLevels match the Kuru SDK exactly", () => {
  // The SDK takes injected l2Book + vault params and makes no RPC call; a provider that would fail proves it.
  const provider = new ethers.providers.StaticJsonRpcProvider("http://127.0.0.1:1", 143);
  const r = rng(7);
  const randomBook = () => {
    const tick = 1e-6, mid = 0.01 + r() * 0.05;
    const bids: [number, number][] = [], asks: [number, number][] = [];
    let b = Math.floor(mid / tick) * tick, a = b + (1 + Math.floor(r() * 20)) * tick;
    const n = 1 + Math.floor(r() * 30);
    for (let i = 0; i < n; i++) {
      bids.push([Number(b.toFixed(8)), Number((200 + r() * 20000).toFixed(r() < 0.5 ? 10 : 0))]);
      if (r() < 0.2) bids.push([Number(b.toFixed(8)), 200]); // duplicate price level: must be summed
      b -= (1 + Math.floor(r() * 50)) * tick;
      asks.push([Number(a.toFixed(8)), Number((200 + r() * 20000).toFixed(r() < 0.5 ? 10 : 0))]);
      a += (1 + Math.floor(r() * 50)) * tick;
    }
    return { mid, bids: bids.filter((x) => x[0] > 0), asks };
  };
  const toBook = (s: Awaited<ReturnType<typeof Kuru.OrderBook.getFormattedL2OrderBook>>) => {
    const ask = s.asks.at(-1)![0]!, bid = s.bids[0]![0]!, mid = (bid + ask) / 2;
    const near = (l: number[][]) => l.filter((x) => Math.abs(x[0]! - mid) / mid < 0.01).reduce((acc, x) => acc + x[1]!, 0);
    const bd = near(s.bids), ad = near(s.asks);
    return { bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10_000, imbalance: bd + ad ? (bd - ad) / (bd + ad) : 0 };
  };

  test("200 random books, half with an active AMM vault", async () => {
    for (let i = 0; i < 200; i++) {
      const { mid, bids, asks } = randomBook();
      const l2Hex = encodeL2(1000 + i, bids, asks);
      const vaultOn = i % 2 === 1;
      const vHex = encodeVault({
        bestBid: BigInt(Math.round(mid * (1 - r() * 0.002) * 1e18)), bidPartial: vaultOn ? BigInt(Math.floor(r() * 1e11)) : 0n,
        bestAsk: BigInt(Math.round(mid * (1 + r() * 0.002) * 1e18)), askPartial: 0n,
        bidSize: vaultOn ? BigInt(Math.round((300 + r() * 5000) * 1e10)) : 0n, askSize: vaultOn ? BigInt(Math.round((300 + r() * 5000) * 1e10)) : 0n,
        spread: BigInt(10 + Math.floor(r() * 90)),
      });
      const sdk = await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, PARAMS as any, abiBytesPayload(l2Hex), obIface.decodeFunctionResult("getVaultParams", vHex) as any);
      const vault = decodeVaultParams(vHex);
      const mine = formatLevels(decodeL2Book(l2Hex, 8, 10), PARAMS, vault);
      expect(mine.bids).toEqual(sdk.bids as any);
      expect(mine.asks).toEqual(sdk.asks as any);
      const book = buildBook(l2Hex, PARAMS, vault);
      expect({ bid: book.bid, ask: book.ask, mid: book.mid, spreadBps: book.spreadBps, imbalance: book.imbalance }).toEqual(toBook(sdk));
      expect(book.block).toBe(sdk.blockNumber);
      if (!vaultOn) expect(buildBook(l2Hex, PARAMS)).toEqual(book); // an inactive vault changes nothing
    }
  }, 60_000);
});

describe("buildBook", () => {
  const hex = encodeL2(55, [[0.0236, 1000], [0.023599, 500], [0.0236, 200], [0.0234, 9000], [0.0233, 1], [0.0232, 1], [0.0231, 1]], [[0.023605, 300], [0.02361, 700], [0.0237, 50], [0.0238, 1], [0.0239, 1], [0.024, 1]]);
  const b = buildBook(hex, PARAMS);
  test("best bid, best ask, mid and spread", () => {
    expect(b.block).toBe(55);
    expect(b.bid).toBe(0.0236);
    expect(b.ask).toBe(0.023605);
    expect(b.mid).toBe((0.0236 + 0.023605) / 2);
    expect(b.spreadBps).toBeCloseTo(((0.023605 - 0.0236) / b.mid) * 1e4, 12);
  });
  test("top five levels each side, best first, duplicates summed", () => {
    expect(b.levels.bids).toEqual([[0.0236, 1200], [0.023599, 500], [0.0234, 9000], [0.0233, 1], [0.0232, 1]]);
    expect(b.levels.asks).toEqual([[0.023605, 300], [0.02361, 700], [0.0237, 50], [0.0238, 1], [0.0239, 1]]);
  });
  test("depth bands are cumulative MON within 10/25/50 bps of mid", () => {
    // mid 0.0236025: 10 bps = 0.0000236 -> 0.023579..0.023626
    expect(b.depthBps["10"]).toEqual({ bid: 1700, ask: 1000 });
    expect(b.depthBps["25"]).toEqual({ bid: 1700, ask: 1000 });
    expect(b.depthBps["50"]).toEqual({ bid: 1700, ask: 1050 });
  });
  test("imbalance counts levels within 1% of mid", () => {
    const near = { bid: 1200 + 500 + 9000, ask: 300 + 700 + 50 + 1 }; // 0.0233 and below, 0.0239 and above are > 1% from 0.0236025
    expect(b.imbalance).toBeCloseTo((near.bid - near.ask) / (near.bid + near.ask), 12);
  });
  test("zero depth within 1% gives imbalance 0, not NaN", () => {
    const wide = buildBook(encodeL2(1, [[0.01, 100]], [[0.05, 100]]), PARAMS);
    expect(wide.imbalance).toBe(0);
  });
  test("throws on a one-sided book (the real MON-USDC book on 2026-10-29)", () => {
    expect(() => buildBook(fixture.getL2Book, PARAMS)).toThrow(/^empty book side at block \d+ \(bids=0 asks=7\)$/);
    expect(() => buildBook(encodeL2(3, [[0.02, 1]], []), PARAMS)).toThrow("empty book side at block 3 (bids=1 asks=0)");
  });
});

describe("readBook / readVaultParams over RPC", () => {
  let m: ReturnType<typeof mockRpc> | null = null;
  afterEach(() => { m?.restore(); m = null; });
  const l2 = encodeL2(77, [[0.0236, 500]], [[0.02361, 500]]);
  const vHex = encodeVault({ bestBid: 23_600_000_000_000_000n, bestAsk: 23_610_000_000_000_000n, bidSize: 0n, askSize: 0n, spread: 30n });

  test("one plain eth_call to getL2Book at 'latest' by default", async () => {
    m = mockRpc((method, params) => { expect(method).toBe("eth_call"); expect(params).toEqual([{ to: MARKET, data: SEL_GET_L2_BOOK }, "latest"]); return l2; });
    const book = await readBook("http://read.example", MARKET, PARAMS);
    expect(book.block).toBe(77);
    expect(m.calls.length).toBe(1);
    expect(Array.isArray(m.calls[0]!.body)).toBe(false);
    expect(m.calls[0]!.url).toBe("http://read.example");
    expect(m.calls[0]!.init.signal).toBeUndefined();
  });

  test("vault: true batches getL2Book and getVaultParams in one HTTP request", async () => {
    m = mockRpc((_, params) => (params[0].data === SEL_GET_L2_BOOK ? l2 : vHex));
    const book = await readBook("http://read.example", MARKET, PARAMS, { vault: true, blockTag: "0x10" });
    expect(book.block).toBe(77);
    expect(m.spy.mock.calls.length).toBe(1);
    expect((m.calls[0]!.body as any[]).map((r) => [r.id, r.params[0].data, r.params[1]])).toEqual([[1, SEL_GET_L2_BOOK, "0x10"], [2, SEL_GET_VAULT_PARAMS, "0x10"]]);
  });

  test("accepts an ethers provider and uses its URL; timeoutMs arms an abort signal", async () => {
    m = mockRpc(() => l2);
    await readBook(new ethers.providers.StaticJsonRpcProvider("http://provider.example", 143), MARKET, PARAMS, { timeoutMs: 500 });
    expect(m.calls[0]!.url).toBe("http://provider.example");
    expect(m.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("errors: HTTP status, RPC error, missing result, vault error", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 429 }));
    expect(readBook("http://x", MARKET, PARAMS)).rejects.toThrow("rpc http 429");
    spy.mockRestore();

    m = mockRpc(() => { throw { code: -32000, message: "execution reverted" }; });
    expect(readBook("http://x", MARKET, PARAMS)).rejects.toThrow("getL2Book: execution reverted");
    m.restore();

    m = mockRpc(() => null);
    expect(readBook("http://x", MARKET, PARAMS)).rejects.toThrow("getL2Book: no result");
    m.restore();

    m = mockRpc((_, params) => { if (params[0].data === SEL_GET_VAULT_PARAMS) throw { message: "boom" }; return l2; });
    expect(readBook("http://x", MARKET, PARAMS, { vault: true })).rejects.toThrow("getVaultParams: boom");
    m.restore();

    m = mockRpc((_, params) => (params[0].data === SEL_GET_VAULT_PARAMS ? null : l2));
    expect(readBook("http://x", MARKET, PARAMS, { vault: true })).rejects.toThrow("getVaultParams: no result");
  });

  test("readVaultParams: one eth_call, decoded; errors surface", async () => {
    m = mockRpc((_, params) => { expect(params).toEqual([{ to: MARKET, data: SEL_GET_VAULT_PARAMS }, "latest"]); return vHex; });
    expect((await readVaultParams("http://x", MARKET)).spread).toBe(30n);
    m.restore();
    m = mockRpc(() => { throw { message: "nope" }; });
    expect(readVaultParams("http://x", MARKET, "0x5")).rejects.toThrow("getVaultParams: nope");
    m.restore();
    m = mockRpc(() => null);
    expect(readVaultParams("http://x", MARKET)).rejects.toThrow("getVaultParams: no result");
  });
});
