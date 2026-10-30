import { afterEach, describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { TRADE_EVENT_SIG, TRADE_PRICE_DEC, TRADE_TOPIC0, TradeFeed } from "../src/trades";
import { config } from "../src/config";
import { mockRpc, obIface, tradeLog } from "./helpers";

const ME = "0x9D65359C49273ca91FDabABFb53d367F58e53Fef";
const url = "http://read.example";
let m: ReturnType<typeof mockRpc> | null = null;
afterEach(() => { m?.restore(); m = null; });

/** Serve `logs` from eth_getLogs, filtered by the requested range like a node would. */
function serve(logs: ReturnType<typeof tradeLog>[]) {
  m = mockRpc((method, params) => {
    expect(method).toBe("eth_getLogs");
    const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16);
    return logs.filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
  });
  return m;
}
const ranges = () => m!.calls.map((c) => [parseInt(c.params[0].fromBlock, 16), parseInt(c.params[0].toBlock, 16)]);

describe("Trade event", () => {
  test("topic0 is keccak256 of the signature and matches the Kuru ABI", () => {
    expect(TRADE_TOPIC0).toBe(ethers.utils.id(TRADE_EVENT_SIG));
    expect(TRADE_TOPIC0).toBe(obIface.getEventTopic("Trade"));
    expect(TRADE_PRICE_DEC).toBe(18);
  });
});

describe("TradeFeed.poll", () => {
  test("first poll warms up over the last 300 blocks in 100-block chunks, with the right filter", async () => {
    serve([]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    expect(ranges()).toEqual([[701, 800], [801, 900], [901, 1000]]);
    expect(m!.calls[0]!.url).toBe(url);
    expect(m!.calls[0]!.params[0]).toEqual({ address: config.market, topics: [TRADE_TOPIC0], fromBlock: "0x2bd", toBlock: "0x320" });
    expect(f.lastBlock).toBe(1000);
  });

  test("then fetches only new blocks; nothing when already up to date", async () => {
    serve([]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    m!.calls.length = 0;
    await f.poll(1001);
    expect(ranges()).toEqual([[1001, 1001]]);
    await f.poll(1001);
    await f.poll(999);
    expect(ranges()).toEqual([[1001, 1001]]);
  });

  test("a warm-up near genesis starts at block 1", async () => {
    serve([]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(50);
    expect(ranges()).toEqual([[1, 50]]);
  });

  test("never replays more than 1000 blocks after a long gap", async () => {
    serve([]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    m!.calls.length = 0;
    await f.poll(10_000);
    expect(ranges().length).toBe(10);
    expect(ranges()[0]).toEqual([9001, 9100]);
    expect(ranges().at(-1)).toEqual([9901, 10_000]);
  });

  test("drops a poll while one is in flight", async () => {
    serve([]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    const a = f.poll(1000), b = f.poll(1001);
    await Promise.all([a, b]);
    expect(ranges()).toEqual([[701, 800], [801, 900], [901, 1000]]);
    expect(f.lastBlock).toBe(1000);
  });

  test("a failed chunk keeps what was fetched and retries the rest next poll; never throws", async () => {
    let failAt = 801;
    m = mockRpc((_, params) => {
      if (parseInt(params[0].fromBlock, 16) === failAt) throw { code: -32007, message: "rate limited" };
      return [];
    });
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    expect(f.lastBlock).toBe(800);
    failAt = -1;
    m.calls.length = 0;
    await f.poll(1000);
    expect(ranges()).toEqual([[801, 900], [901, 1000]]);
    expect(f.lastBlock).toBe(1000);
  });

  test("decodes prints: taker side, 1e18 price, size scaled by sizePrecision; skips removed, short and empty logs", async () => {
    const good = tradeLog({ block: 990, isBuy: true, price: 0.023552, size: 512.25 });
    serve([
      good,
      tradeLog({ block: 991, isBuy: false, price: 0.0235, size: 200 }),
      { ...tradeLog({ block: 992, isBuy: true, price: 0.03, size: 1 }), removed: true }, // reorged out
      { ...good, blockNumber: "0x3e1", data: good.data.slice(0, 2 + 64 * 7) }, // truncated
      tradeLog({ block: 994, isBuy: true, price: 0.02, size: 0 }), // nothing filled
    ]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    expect(f.recent(10)).toEqual([
      { block: 990, price: 0.023552, size: 512.25, side: "buy" },
      { block: 991, price: 0.0235, size: 200, side: "sell" },
    ]);
  });

  test("accepts log data without the 0x prefix and a custom price precision", async () => {
    const l = tradeLog({ block: 999, isBuy: false, price: 0.0236, size: 300 });
    serve([{ ...l, data: l.data.slice(2) }]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10, priceDec: 17 });
    await f.poll(1000);
    expect(f.recent(1)).toEqual([{ block: 999, price: 0.236, size: 300, side: "sell" }]);
  });

  test("keeps the newest 500 prints", async () => {
    serve(Array.from({ length: 700 }, (_, i) => tradeLog({ block: 701 + Math.floor(i / 3), isBuy: i % 2 === 0, price: 0.02 + i * 1e-6, size: 200, logIndex: i })));
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    const all = f.recent(10_000);
    expect(all.length).toBe(500);
    expect(all.at(-1)!.price).toBeCloseTo(0.02 + 699e-6, 12);
    expect(f.recent(2).length).toBe(2);
  });
});

describe("maker fills", () => {
  test("our maker address becomes a fill with OUR side and the order's remaining size; case-insensitive", async () => {
    const logs = [
      tradeLog({ block: 1001, orderId: 77, maker: ME.toLowerCase(), isBuy: true, price: 0.0236, size: 150, updated: 50, tx: "0xaa" }),
      tradeLog({ block: 1001, orderId: 78, maker: ME, isBuy: false, price: 0.0235, size: 200, updated: 0, tx: "0xbb" }),
      tradeLog({ block: 1001, orderId: 79, isBuy: false, price: 0.0235, size: 200 }), // someone else's order
    ];
    serve(logs);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10, maker: ME });
    await f.poll(1000);
    await f.poll(1001);
    expect(f.drainFills()).toEqual([
      { block: 1001, txHash: "0xaa", orderId: 77, price: 0.0236, size: 150, updatedSize: 50, side: "sell" }, // taker bought: our ask filled
      { block: 1001, txHash: "0xbb", orderId: 78, price: 0.0235, size: 200, updatedSize: 0, side: "buy" },
    ]);
    expect(f.drainFills()).toEqual([]);
  });

  test("the warm-up window predates our orders: no fills from it", async () => {
    serve([tradeLog({ block: 900, maker: ME, isBuy: true, price: 0.0236, size: 200 })]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10, maker: ME });
    await f.poll(1000);
    expect(f.drainFills()).toEqual([]);
    expect(f.recent(1).length).toBe(1); // still a print for the model
  });

  test("no maker (dry run): never any fills", async () => {
    serve([tradeLog({ block: 1001, maker: ME, isBuy: true, price: 0.0236, size: 200 })]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10, maker: null });
    await f.poll(1000);
    await f.poll(1001);
    expect(f.drainFills()).toEqual([]);
  });

  test("drainPrints returns prints since the last drain, oldest first", async () => {
    serve([tradeLog({ block: 999, isBuy: true, price: 0.02, size: 200 }), tradeLog({ block: 1001, isBuy: false, price: 0.021, size: 300 })]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    expect(f.drainPrints().map((p) => p.block)).toEqual([999]);
    expect(f.drainPrints()).toEqual([]);
    await f.poll(1001);
    expect(f.drainPrints().map((p) => p.block)).toEqual([1001]);
  });
});

describe("TradeFeed.summary", () => {
  test("taker volume, CVD, VWAP and the last print over the window (exclusive of its start)", async () => {
    serve([
      tradeLog({ block: 900, isBuy: true, price: 0.03, size: 999 }), // outside: block <= 1000 - 100
      tradeLog({ block: 901, isBuy: true, price: 0.02, size: 300 }),
      tradeLog({ block: 950, isBuy: false, price: 0.024, size: 100 }),
      tradeLog({ block: 1000, isBuy: true, price: 0.022, size: 200 }),
    ]);
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    await f.poll(1000);
    const s = f.summary(100, 1000);
    expect(s).toEqual({ count: 3, buyMon: 500, sellMon: 100, cvdMon: 400, vwap: (300 * 0.02 + 100 * 0.024 + 200 * 0.022) / 600, lastPrice: 0.022, lastSide: "buy" });
  });

  test("no prints: zeros and nulls", () => {
    const f = new TradeFeed({ market: config.market, url, sizeDec: 10 });
    expect(f.summary(100, 1000)).toEqual({ count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null });
    expect(f.recent(5)).toEqual([]);
  });
});
