import { afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "../src/config";

export const obIface = new ethers.utils.Interface(OrderBookAbi.abi);
const BN = ethers.BigNumber;

/** Kuru MON-USDC market params exactly as Kuru.ParamFetcher.getMarketParams returned them from mainnet. */
export const PARAMS = {
  pricePrecision: BN.from("100000000"),
  sizePrecision: BN.from("10000000000"),
  baseAssetAddress: "0x0000000000000000000000000000000000000000",
  baseAssetDecimals: BN.from(18),
  quoteAssetAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  quoteAssetDecimals: BN.from(6),
  tickSize: BN.from(100),
  minSize: BN.from("2000000000000"),
  maxSize: BN.from("2000000000000000000"),
  takerFeeBps: BN.from(0),
  makerFeeBps: BN.from(0),
};

/** getL2Book() return data in the on-chain layout: bids best first, a zero word, asks best (lowest) first. Prices/sizes in human units. */
export function encodeL2(block: number, bids: [number, number][], asks: [number, number][]): string {
  const p = (x: number) => BigInt(Math.round(x * 1e8)), s = (x: number) => BigInt(Math.round(x * 1e10));
  const words = [BigInt(block), ...bids.flatMap(([a, b]) => [p(a), s(b)]), 0n, ...asks.flatMap(([a, b]) => [p(a), s(b)])];
  return ethers.utils.defaultAbiCoder.encode(["bytes"], ["0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("")]);
}

export function encodeVault(v: { vault?: string; bestBid: bigint; bidPartial?: bigint; bestAsk: bigint; askPartial?: bigint; bidSize: bigint; askSize: bigint; spread: bigint }): string {
  return obIface.encodeFunctionResult("getVaultParams", [v.vault ?? "0x838c2d3fD4DB5eB2F185cbE7697fbaAce52b34d7", v.bestBid, v.bidPartial ?? 0n, v.bestAsk, v.askPartial ?? 0n, v.bidSize, v.askSize, v.spread]);
}

/** A raw Trade log as eth_getLogs returns it. */
export function tradeLog(o: { block: number; orderId?: number; maker?: string; isBuy: boolean; price: number; size: number; updated?: number; tx?: string; removed?: boolean; logIndex?: number }) {
  const enc = obIface.encodeEventLog(obIface.getEvent("Trade"), [
    o.orderId ?? 1, o.maker ?? "0x00000000000000000000000000000000000a11ce", o.isBuy,
    BigInt(Math.round(o.price * 1e8)) * 10n ** 10n, BigInt(Math.round((o.updated ?? 0) * 1e10)),
    "0x0000000000000000000000000000000000007a1e", "0x0000000000000000000000000000000000007a1e", BigInt(Math.round(o.size * 1e10)),
  ]);
  return {
    address: config.market.toLowerCase(), topics: enc.topics, data: enc.data, blockNumber: "0x" + o.block.toString(16),
    transactionHash: o.tx ?? "0x" + o.block.toString(16).padStart(64, "0"), logIndex: "0x" + (o.logIndex ?? 0).toString(16), ...(o.removed ? { removed: true } : {}),
  };
}

type RpcHandler = (method: string, params: any[], url: string) => unknown;

/**
 * Replace global fetch with a JSON-RPC responder for the current test file. The handler returns the
 * `result`; throw `{ code, message }` to answer with a JSON-RPC error. Records every call.
 */
export function mockRpc(handler: RpcHandler) {
  const calls: { url: string; method: string; params: any[]; body: any; init: RequestInit }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init.body));
    const one = async (req: any) => {
      calls.push({ url, method: req.method, params: req.params, body, init });
      try { return { jsonrpc: "2.0", id: req.id, result: await handler(req.method, req.params, url) }; }
      catch (e: any) { return { jsonrpc: "2.0", id: req.id, error: { code: e.code ?? -32000, message: e.message } }; }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    return new Response(JSON.stringify(out), { status: 200 });
  }) as any);
  return { calls, spy, restore: () => spy.mockRestore() };
}

/** Snapshot config before the file's tests and put it back after, so files do not leak settings into each other. */
export function isolateConfig() {
  let saved: typeof config;
  beforeAll(() => { saved = { ...config }; });
  afterEach(() => { Object.assign(config, saved); });
  afterAll(() => { Object.assign(config, saved); });
}

/** Run the file's tests from a fresh temp dir (the trader appends to ./data/events.jsonl). */
export function inTempDir() {
  const prev = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "jev-trader-test-"));
  beforeAll(() => process.chdir(dir));
  afterAll(() => process.chdir(prev));
  return dir;
}

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** Poll `cond` until true (real time). */
export async function until(cond: () => boolean, timeoutMs = 5000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}
