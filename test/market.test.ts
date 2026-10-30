import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ethers } from "ethers";
import { config } from "../src/config";
import { Market, type Book, type Side } from "../src/market";
import { BASE_FEE, LADDER_MAKER, startPracticeExchange, type PracticeExchange } from "../scripts/practice-exchange";
import { PARAMS, isolateConfig, obIface } from "./helpers";

isolateConfig();
const log = spyOn(console, "log").mockImplementation(() => {});
const warn = spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => { log.mockRestore(); warn.mockRestore(); });
afterEach(() => { log.mockClear(); warn.mockClear(); });

const TICK = 1e-6;
/** The practice exchange's gas for one place, and the limits the bot derives from it (10% headroom, 25k per cancel). */
const PLACE = Math.floor(282_170 * 1.1), CANCEL = 25_000;
const book = (bid: number, ask: number): Book => ({ block: 1, bid, ask, mid: (bid + ask) / 2, spreadBps: 0, imbalance: 0, levels: { bids: [], asks: [] }, depthBps: {} });
const units = (p: number) => Math.round(p * 1e8);

/** A Market on the practice exchange with a throwaway key (or a dry run). */
function market(ex: PracticeExchange, dry = false) {
  config.rpcUrl = config.readRpcUrl = ex.url;
  config.dryRun = dry;
  config.privateKey = dry ? undefined : ethers.Wallet.createRandom().privateKey;
  const m = new Market();
  m.provider.pollingInterval = 20; // ethers waits for receipts by polling
  return m;
}
/** Mine in the background while `fn` runs (startup deposits wait for their receipts). */
async function mining<T>(ex: PracticeExchange, fn: () => Promise<T>): Promise<T> {
  const t = setInterval(() => ex.mine(), 15);
  try { return await fn(); } finally { clearInterval(t); }
}
const count = (ex: PracticeExchange, method: string) => ex.requests.get(method) ?? 0;

// ------------------------------------------------------------------------------------------------

describe("quotePrice (no RPC)", () => {
  const m = new Market();
  m.params = PARAMS as any;
  const bid = 0.023598, ask = 0.023604; // 6 ticks wide

  test("one tick inside the touch on our side", () => {
    config.quoteInsideTicks = 1;
    expect(m.quotePrice("buy", book(bid, ask))).toBe(0.023599);
    expect(m.quotePrice("sell", book(bid, ask))).toBe(0.023603);
  });
  test("QUOTE_INSIDE_TICKS=0 joins the touch; more ticks step further in", () => {
    config.quoteInsideTicks = 0;
    expect(m.quotePrice("buy", book(bid, ask))).toBe(bid);
    expect(m.quotePrice("sell", book(bid, ask))).toBe(ask);
    config.quoteInsideTicks = 3;
    expect(m.quotePrice("buy", book(bid, ask))).toBe(0.023601);
    expect(m.quotePrice("sell", book(bid, ask))).toBe(0.023601);
  });
  test("never crosses: a spread too tight to step inside joins the touch", () => {
    config.quoteInsideTicks = 1;
    expect(m.quotePrice("buy", book(0.0236, 0.023601))).toBe(0.0236);
    expect(m.quotePrice("sell", book(0.0236, 0.023601))).toBe(0.023601);
    config.quoteInsideTicks = 6;
    expect(m.quotePrice("buy", book(bid, ask))).toBe(bid);
    expect(m.quotePrice("sell", book(bid, ask))).toBe(ask);
  });
  test("property: tick aligned, at or inside the touch, never crossing (random books and settings)", () => {
    let seed = 9;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 5000; i++) {
      config.quoteInsideTicks = Math.floor(r() * 6);
      const b = Math.round((0.005 + r() * 0.1) / TICK) * TICK, a = b + (1 + Math.floor(r() * 12)) * TICK;
      const bk = book(Number(b.toFixed(6)), Number(a.toFixed(6)));
      for (const side of ["buy", "sell"] as Side[]) {
        const p = m.quotePrice(side, bk);
        expect(units(p) % 100).toBe(0);
        if (side === "buy") { expect(p).toBeGreaterThanOrEqual(bk.bid); expect(p).toBeLessThan(bk.ask); }
        else { expect(p).toBeLessThanOrEqual(bk.ask); expect(p).toBeGreaterThan(bk.bid); }
      }
    }
  });
});

describe("encode / buildTx (no RPC)", () => {
  config.privateKey = ethers.Wallet.createRandom().privateKey;
  config.dryRun = false;
  const m = new Market();
  m.params = PARAMS as any;

  test("batchUpdate: one post-only order on our side, the cancels, margin funded (value 0)", () => {
    for (const side of ["buy", "sell"] as Side[]) {
      const d = obIface.decodeFunctionData("batchUpdate", m.encode(side, 200, 0.023599, [101, 102]));
      const [bp, bs, sp, ss, ids, postOnly] = [d[0], d[1], d[2], d[3], d[4], d[5]];
      const [ours, oursSize, other] = side === "buy" ? [bp, bs, sp] : [sp, ss, bp];
      expect(ours.map(Number)).toEqual([2359900]);
      expect(oursSize.map(String)).toEqual(["2000000000000"]);
      expect(other).toEqual([]);
      expect(ids.map(Number)).toEqual([101, 102]);
      expect(postOnly).toBe(true);
    }
  });
  test("fractional sizes keep full size precision", () => {
    const d = obIface.decodeFunctionData("batchUpdate", m.encode("sell", 200.1234567891, 0.0236, []));
    expect(String(d[3][0])).toBe("2001234567891");
    expect(d[4]).toEqual([]);
  });
  test("type-2 tx to the market: static fees from config, a gas limit sized to its cancels, the local nonce, chain 143", async () => {
    config.maxFeeGwei = 400; config.priorityFeeGwei = 2;
    const tx = m.buildTx("buy", 200, 0.023599, []);
    expect(tx).toMatchObject({ type: 2, chainId: 143, to: config.market, nonce: 0 });
    expect(String(tx.gasLimit)).toBe("325000"); // before any estimate: the 350k fallback is one place + one cancel
    expect(String(m.buildTx("buy", 200, 0.023599, [1]).gasLimit)).toBe("350000");
    expect(String(m.buildTx("buy", 200, 0.023599, [1, 2, 3]).gasLimit)).toBe("400000");
    expect(String(tx.maxFeePerGas)).toBe("400000000000");
    expect(String(tx.maxPriorityFeePerGas)).toBe("2000000000");
    expect(String(tx.value)).toBe("0");
    const parsed = ethers.utils.parseTransaction(await m.wallet!.signTransaction(tx));
    expect(parsed.from).toBe(m.address!);
    expect(parsed.chainId).toBe(143);
  });
});

// ------------------------------------------------------------------------------------------------

describe("dry run", () => {
  let ex: PracticeExchange;
  beforeAll(() => { ex = startPracticeExchange({ seed: 1, takersPerBlock: 0, volBps: 0 }); });
  afterAll(() => ex.stop());

  test("no wallet: init reads params and the book, never signs, never sends", async () => {
    const m = market(ex, true);
    expect(m.wallet).toBeNull();
    expect(m.address).toBeNull();
    await m.init();
    expect(m.params.pricePrecision.toString()).toBe("100000000");
    const b = await m.readBook();
    expect(b.block).toBe(ex.block);
    expect(b.ask).toBeGreaterThan(b.bid);
    const q = await m.send(ex.block, "buy", 200, b, [5], false);
    expect(q).toEqual({ side: "buy", price: m.quotePrice("buy", b), size: 200, txHash: null, gasMon: 0, cancel: [5], status: "sim", orderId: null, capped: false });
    for (const method of ["eth_sendRawTransaction", "eth_getTransactionCount", "eth_estimateGas"]) expect(count(ex, method)).toBe(0);
    expect(await m.pollPending(ex.block)).toEqual([]);
    expect(m.margin).toEqual({ mon: 0, usdc: 0 });
  });
});

describe("live startup", () => {
  let ex: PracticeExchange;
  beforeEach(() => { ex = startPracticeExchange({ seed: 2, takersPerBlock: 0, volBps: 0 }); });
  afterEach(() => ex.stop());

  test("deposits MON and USDC into margin, then estimates the gas limit once", async () => {
    const m = market(ex);
    await mining(ex, () => m.init());
    expect(ex.margin(m.address!)).toEqual({ mon: 600, usdc: 20 });
    expect(m.margin).toEqual({ mon: 600, usdc: 20 });
    expect((m as any).nonce).toBe(3); // MON deposit, USDC approve, USDC deposit
    expect(String(m.gasLimitFor(0))).toBe(String(PLACE));
    expect(String(m.gasLimitFor(2))).toBe(String(PLACE + 2 * CANCEL));
    expect(count(ex, "eth_estimateGas")).toBeGreaterThanOrEqual(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("margin: depositing 600.0 MON");
    expect(lines).toContain("margin: depositing 20.0 USDC");
    expect(lines.some((l) => l.startsWith(`gas limit ${PLACE} + 25000 per cancel · maxFee 400 gwei · priority 2 gwei · ~0.0342 MON per block`))).toBe(true);
  });

  test("tops up only what is missing, and skips the approval when the allowance covers it", async () => {
    const m = market(ex);
    await mining(ex, () => m.init());
    ex.setMargin(m.address!, 450, 5);
    log.mockClear();
    const again = new Market(); // same key
    again.provider.pollingInterval = 20;
    await mining(ex, () => again.init());
    expect(ex.margin(m.address!)).toEqual({ mon: 600, usdc: 20 });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("margin: depositing 150.0 MON");
    expect(lines).toContain("margin: depositing 15.0 USDC");
    expect((again as any).nonce).toBe(5); // two deposits, no second approve
  });

  test("already funded: no deposits at all", async () => {
    const m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init();
    expect(count(ex, "eth_sendRawTransaction")).toBe(0);
  });

  test("a wallet short of USDC deposits what it has and says so; an empty one deposits nothing", async () => {
    ex.stop();
    ex = startPracticeExchange({ seed: 2, takersPerBlock: 0, volBps: 0, faucet: { mon: 10_000, usdc: 7.5 } });
    const m = market(ex);
    await mining(ex, () => m.init());
    expect(ex.margin(m.address!).usdc).toBe(7.5);
    expect(String(warn.mock.calls[0]![0])).toBe("margin: wallet has 7.5 USDC, wanted to deposit 20.0; depositing what is there");

    ex.stop();
    ex = startPracticeExchange({ seed: 2, takersPerBlock: 0, volBps: 0, faucet: { mon: 10_000, usdc: 0 } });
    const n = market(ex);
    await mining(ex, () => n.init());
    expect(ex.margin(n.address!)).toEqual({ mon: 600, usdc: 0 });
    expect((n as any).nonce).toBe(1); // only the MON deposit
  });

  test("warns at startup when margin cannot fund MAX_POSITION_MON both ways; quiet when it can", async () => {
    const m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init();
    const b = await m.readBook();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`margin funds about 600 MON of selling and ${Math.floor(20 / b.ask)} MON of buying, less than MAX_POSITION_MON 1000: when one runs out that side is skipped (capped) until fills refill it`);
    warn.mockClear();
    [config.marginMon, config.marginUsdc] = [1200, 30];
    const n = market(ex);
    ex.setMargin(n.address!, 1200, 30);
    await n.init();
    expect(warn).not.toHaveBeenCalled();
  });

  test("GAS_HEADROOM sets the margin over the estimate", async () => {
    config.gasHeadroom = 0.2;
    const m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init();
    expect(String(m.gasLimitFor(0))).toBe(String(Math.floor(282_170 * 1.2)));
  });

  test("GAS_LIMIT skips the estimate", async () => {
    config.gasLimit = 400_000;
    const m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init();
    expect(count(ex, "eth_estimateGas")).toBe(0);
    expect(String(m.gasLimitFor(0))).toBe("400000");
    expect(String(m.gasLimitFor(3))).toBe("400000");
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("gas limit 400000 (fixed)"))).toBe(true);
  });

  test("a failed estimate (no margin to place with) falls back to 350000 with a warning", async () => {
    config.marginMon = 0; config.marginUsdc = 0;
    const m = market(ex);
    await m.init();
    expect(String(m.gasLimitFor(1))).toBe("350000");
    const gasWarning = warn.mock.calls.map((c) => String(c[0])).find((w) => w.startsWith("gas estimate failed"));
    expect(gasWarning).toBe("gas estimate failed (execution reverted: InsufficientBalance); using 350000"); // the node's reason, not ethers' preamble
  });

  test("the startup estimate quotes the side margin can fund: buy with enough USDC, else sell", async () => {
    const sides: Side[] = [];
    ex.override("eth_estimateGas", (p) => {
      if (p[0].to.toLowerCase() === config.market.toLowerCase()) sides.push(obIface.decodeFunctionData("batchUpdate", p[0].data)[0].length ? "buy" : "sell");
      return undefined;
    });
    const m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init();
    config.marginUsdc = 0; // no top-up
    const n = market(ex);
    ex.setMargin(n.address!, 600, 1); // 1 USDC < 200 MON x ~0.0236
    await n.init();
    expect(sides).toEqual(["buy", "sell"]);
  });
});

// ------------------------------------------------------------------------------------------------

describe("live quoting", () => {
  let ex: PracticeExchange, m: Market;
  beforeEach(async () => {
    ex = startPracticeExchange({ seed: 4, takersPerBlock: 0, volBps: 0 });
    m = market(ex);
    ex.setMargin(m.address!, 600, 20);
    await m.init(); // gas for one place estimated at 282,170 (+10%); fee from eth_gasPrice: 102 gwei
  });
  afterEach(() => ex.stop());
  const gasMon = (limit: number, gwei: number) => Number(ethers.utils.formatEther(ethers.BigNumber.from(limit).mul(ethers.utils.parseUnits(String(gwei), "gwei"))));

  test("send fires one raw tx and returns at once with status 'sent' and gas = limit x last known fee", async () => {
    const b = await m.readBook();
    const q = await m.send(ex.block, "buy", 200, b, [], false);
    expect(q).toMatchObject({ side: "buy", price: m.quotePrice("buy", b), size: 200, status: "sent", orderId: null, cancel: [], capped: false });
    expect(q.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.gasMon).toBeCloseTo(gasMon(PLACE, 102), 12);
    expect((m as any).nonce).toBe(1);
    expect(count(ex, "eth_estimateGas")).toBe(1); // only at startup, never per order
  });

  test("the receipt resolves it to 'placed' with the new order id; the next order cancels it", async () => {
    const q1 = await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    expect(await m.pollPending(ex.block)).toEqual([]); // not mined yet
    ex.mine();
    const [r1] = await m.pollPending(ex.block);
    const id1 = [...ex.orders.keys()][0]!;
    expect(r1).toEqual({ block: ex.block - 1, quote: { ...q1, status: "placed", orderId: id1, gasMon: gasMon(PLACE, 102) }, canceled: [], minedBlock: ex.block });

    const q2 = await m.send(ex.block, "sell", 200, await m.readBook(), [id1], true);
    ex.mine();
    const [r2] = await m.pollPending(ex.block);
    expect(r2!.quote).toMatchObject({ side: "sell", status: "placed", capped: true, cancel: [id1] });
    expect(r2!.canceled).toEqual([id1]);
    expect(ex.orders.has(id1)).toBe(false);
    expect([...ex.orders.values()].map((o) => [o.isBuy, o.priceU])).toEqual([[false, units(q2.price)]]);
  });

  test("each cancel adds GAS_PER_CANCEL to the limit, and the update pays for exactly that", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const ids = (await m.pollPending(ex.block)).map((r) => r.quote.orderId!);
    const q = await m.send(ex.block, "sell", 200, await m.readBook(), ids, false);
    expect(q.gasMon).toBeCloseTo(gasMon(PLACE + 2 * CANCEL, 102), 12);
    ex.mine();
    const [r] = await m.pollPending(ex.block);
    expect(r!.quote.status).toBe("placed");
    expect(r!.canceled.sort()).toEqual(ids.sort());
  });

  test("without the per-cancel allowance an update with two cancels runs out of gas (and still pays for it)", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const ids = (await m.pollPending(ex.block)).map((r) => r.quote.orderId!);
    config.gasPerCancel = 0;
    await m.send(ex.block, "sell", 200, await m.readBook(), ids, false);
    ex.mine();
    const [r] = await m.pollPending(ex.block);
    expect(r!.quote.status).toBe("reverted");
    expect(ex.receipt(r!.quote.txHash!)!.reason).toBe("out of gas");
    expect(r!.quote.gasMon).toBeGreaterThan(0);
  });

  test("a quote the book moved through reverts: status 'reverted', no order, gas still charged", async () => {
    const real = await m.readBook();
    const stale = book(real.ask + 5 * TICK, real.ask + 10 * TICK); // our bid lands above the real best ask
    await m.send(ex.block, "buy", 200, stale, [], false);
    ex.mine();
    const [r] = await m.pollPending(ex.block);
    expect(r!.quote.status).toBe("reverted");
    expect(r!.quote.orderId).toBeNull();
    expect(r!.canceled).toEqual([]);
    expect(r!.quote.gasMon).toBeGreaterThan(0);
    expect(ex.receipt(r!.quote.txHash!)!.reason).toBe("PostOnlyError");
  });

  test("cancelling an order that already filled reverts the whole update", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const [r] = await m.pollPending(ex.block);
    ex.taker(false, 1_000_000); // a taker sells through the whole bid side, ours included
    ex.mine();
    expect(ex.orders.size).toBe(0);
    ex.mine(); // the sweep emptied the bid ladder; the next block rebuilds it
    await m.send(ex.block, "buy", 200, await m.readBook(), [r!.quote.orderId!], false);
    ex.mine();
    const [r2] = await m.pollPending(ex.block);
    expect(r2!.quote.status).toBe("reverted");
    expect(ex.receipt(r2!.quote.txHash!)!.reason).toMatch(/^OnlyOwnerAllowedError/); // what mainnet Kuru reverts with
  });

  test("no receipt for pendingBlocks blocks: 'lost', no gas, and the nonce resyncs", async () => {
    ex.override("eth_getTransactionReceipt", () => ({ result: null }));
    const sentAt = ex.block;
    const q = await m.send(sentAt, "buy", 200, await m.readBook(), [], false);
    expect(await m.pollPending(sentAt + 9)).toEqual([]);
    const before = count(ex, "eth_getTransactionCount");
    const [r] = await m.pollPending(sentAt + 10);
    expect(r).toEqual({ block: sentAt, quote: { ...q, status: "lost", gasMon: 0 }, canceled: [], minedBlock: null });
    expect(count(ex, "eth_getTransactionCount")).toBe(before + 2); // latest and pending
    expect(await m.pollPending(sentAt + 11)).toEqual([]);
  });

  test("a receipt lookup that errors just stays pending", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    ex.override("eth_getTransactionReceipt", () => ({ error: { code: -32007, message: "rate limited" } }));
    expect(await m.pollPending(ex.block)).toEqual([]);
    ex.override("eth_getTransactionReceipt", null);
    expect((await m.pollPending(ex.block)).length).toBe(1);
  });

  test("overlapping polls resolve a receipt once", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const [a, b] = await Promise.all([m.pollPending(ex.block), m.pollPending(ex.block)]);
    expect(a.length + b.length).toBe(1);
  });

  test("only OUR OrderCreated / OrdersCanceled count; foreign and unparseable logs are skipped; the fee follows the receipt", async () => {
    const q = await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const real = ex.receipt(q.txHash!)!;
    const other = "0x000000000000000000000000000000000000beef";
    const foreign = [
      { ...obIface.encodeEventLog(obIface.getEvent("OrderCreated"), [999, other, 1, 1, true]), address: config.market },
      { ...obIface.encodeEventLog(obIface.getEvent("OrdersCanceled"), [[5, 6], other]), address: config.market },
      { topics: [ethers.utils.id("Transfer(address,address,uint256)")], data: "0x", address: config.market },
    ].map((l, i) => ({ ...l, blockNumber: "0x1", blockHash: ethers.constants.HashZero, transactionHash: q.txHash, transactionIndex: "0x0", logIndex: "0x" + (i + 10).toString(16), removed: false }));
    ex.override("eth_getTransactionReceipt", () => ({
      result: {
        transactionHash: q.txHash, transactionIndex: "0x0", blockHash: ethers.constants.HashZero, blockNumber: "0x" + real.block.toString(16), from: m.address, to: config.market,
        contractAddress: null, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x" + (150n * 10n ** 9n).toString(16), status: "0x1", type: "0x2", logsBloom: "0x" + "00".repeat(256),
        logs: [...foreign, ...real.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: "0x1", blockHash: ethers.constants.HashZero, transactionHash: q.txHash, transactionIndex: "0x0", logIndex: "0x" + l.logIndex.toString(16), removed: false }))],
      },
    }));
    const [r] = await m.pollPending(ex.block);
    expect(r!.quote.orderId).toBe([...ex.orders.keys()][0]!);
    expect(r!.canceled).toEqual([]);
    expect(r!.quote.gasMon).toBeCloseTo(gasMon(PLACE, 150), 12);
    const next = await m.send(ex.block, "sell", 200, await m.readBook(), [], false);
    expect(next.gasMon).toBeCloseTo(gasMon(PLACE, 150), 12); // last known fee is now 150 gwei
  });

  test("a receipt without effectiveGasPrice prices gas at the last known fee", async () => {
    const q = await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    ex.override("eth_getTransactionReceipt", () => ({ result: { transactionHash: q.txHash, status: "0x1", logs: [] } }));
    const [r] = await m.pollPending(ex.block);
    expect(r!.quote).toMatchObject({ status: "placed", orderId: null, gasMon: gasMon(PLACE, 102) });
  });

  test("a rejected send resyncs the nonce and rethrows", async () => {
    ex.override("eth_sendRawTransaction", () => ({ error: { code: -32000, message: "insufficient funds" } }));
    const before = count(ex, "eth_getTransactionCount");
    expect(m.send(ex.block, "buy", 200, await m.readBook(), [], false)).rejects.toThrow("eth_sendRawTransaction: insufficient funds (-32000)");
    await Bun.sleep(50);
    expect(count(ex, "eth_getTransactionCount")).toBe(before + 2);
    expect((m as any).nonce).toBe(0);
  });

  test("if the resync itself fails, the original send error still surfaces and a lost tx is still reported lost", async () => {
    ex.override("eth_sendRawTransaction", () => ({ error: { code: -32000, message: "nonce too low" } }));
    ex.override("eth_getTransactionCount", () => ({ error: { code: -32603, message: "node down" } }));
    expect(m.send(ex.block, "buy", 200, await m.readBook(), [], false)).rejects.toThrow("eth_sendRawTransaction: nonce too low (-32000)");
    await Bun.sleep(50);
    ex.override("eth_sendRawTransaction", null);
    ex.override("eth_getTransactionReceipt", () => ({ result: null }));
    const sentAt = ex.block;
    await m.send(sentAt, "buy", 200, await m.readBook(), [], false);
    const [r] = await m.pollPending(sentAt + 10);
    expect(r!.quote.status).toBe("lost");
  });

  test("margin: a chain read as of a block, with our later moves replayed on top; moves the read has are skipped", async () => {
    const tags: string[] = [];
    ex.override("eth_call", (p) => { if (p[0].to.toLowerCase() === config.marginAccount.toLowerCase()) tags.push(p[1]); return undefined; });
    expect(m.margin).toEqual({ mon: 600, usdc: 20 });
    m.moveMargin(null, -1, 0); // apply now (not tied to a block)
    m.moveMargin(ex.block + 5, 0, -2); // newer than any read yet
    expect(m.margin).toEqual({ mon: 599, usdc: 18 });
    await m.refreshMargin(ex.block);
    expect(tags).toEqual(["0x" + ex.block.toString(16), "0x" + ex.block.toString(16)]);
    expect(m.margin).toEqual({ mon: 600, usdc: 18 }); // the chain, plus the move from a later block
    m.moveMargin(ex.block, 7, 0); // the read already includes this block
    expect(m.margin.mon).toBe(600);
    m.moveMargin(ex.block + 1, 7, 0);
    expect(m.margin.mon).toBe(607);
    await m.refreshMargin(ex.block + 5); // a read that includes both moves
    expect(m.margin).toEqual({ mon: 600, usdc: 20 });
  });

  test("margin: unavailable pinned state keeps the ledger instead of double-counting newer moves", async () => {
    ex.override("eth_call", (p) => (p[1] !== "latest" && p[0].to.toLowerCase() === config.marginAccount.toLowerCase() ? { error: { code: -32000, message: "state not available" } } : undefined));
    ex.setMargin(m.address!, 321, 9);
    m.moveMargin(ex.block + 1, 10, -2);
    const before = { ...m.margin };
    await expect(m.refreshMargin(ex.block)).rejects.toThrow("state not available");
    expect(m.margin).toEqual(before);
  });

  test("orderSizes reads s_orders: ours with what is left, 0 once gone or if it is someone else's", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false);
    ex.mine();
    const [mine] = await m.pollPending(ex.block);
    const other = market(ex); // a second trader on the same book
    ex.setMargin(other.address!, 600, 20);
    await other.init();
    await other.send(ex.block, "sell", 200, await other.readBook(), [], false);
    ex.mine();
    const [theirs] = await other.pollPending(ex.block);
    const sizes = await m.orderSizes([mine!.quote.orderId!, theirs!.quote.orderId!, 42]);
    expect([...sizes.entries()]).toEqual([[mine!.quote.orderId!, 200], [theirs!.quote.orderId!, 0], [42, 0]]);
  });

  test("nonce resync takes the higher of confirmed and pending, and survives a pending lookup error", async () => {
    await m.send(ex.block, "buy", 200, await m.readBook(), [], false); // in the mempool, unmined
    (m as any).nonce = 0;
    await (m as any).resyncNonce();
    expect((m as any).nonce).toBe(1);
    ex.mine();
    ex.override("eth_getTransactionCount", (p) => (p[1] === "pending" ? { error: { code: -1, message: "unsupported" } } : undefined));
    (m as any).nonce = 0;
    await (m as any).resyncNonce();
    expect((m as any).nonce).toBe(1);
  });
});

describe("refresh", () => {
  test("fee, margin balances and the vault flag; a failing piece keeps its old value", async () => {
    const ex = startPracticeExchange({ seed: 5, takersPerBlock: 0, volBps: 0, vault: true });
    try {
      const m = market(ex);
      m.params = PARAMS as any;
      ex.setMargin(m.address!, 123, 4.5);
      ex.override("eth_gasPrice", () => ({ result: "0x" + (130n * 10n ** 9n).toString(16) }));
      await m.refresh();
      expect(m.margin).toEqual({ mon: 123, usdc: 4.5 });
      expect(String((m as any).feeWei)).toBe(String(130n * 10n ** 9n));
      expect((m as any).useVault).toBe(true);

      const before = ex.requests.get("eth_call") ?? 0;
      await m.readBook(); // vault live: getL2Book + getVaultParams in one batch
      expect((ex.requests.get("eth_call") ?? 0) - before).toBe(2);

      ex.override("eth_gasPrice", () => ({ error: { code: -1, message: "down" } }));
      ex.override("eth_call", () => ({ error: { code: -1, message: "down" } }));
      await m.refresh();
      expect(String((m as any).feeWei)).toBe(String(130n * 10n ** 9n));
      expect((m as any).useVault).toBe(true);
      expect(m.margin).toEqual({ mon: 123, usdc: 4.5 });
    } finally { ex.stop(); }
  });
});

// The practice exchange itself: sanity that it is a fair stand-in (used by the trader and e2e tests).
describe("practice exchange", () => {
  test("takers walk the book best price first, our older order before the ladder at the same price", async () => {
    const ex = startPracticeExchange({ seed: 6, takersPerBlock: 0, volBps: 0 });
    try {
      const m = market(ex);
      ex.setMargin(m.address!, 600, 20);
      await m.init();
      await m.send(ex.block, "sell", 200, await m.readBook(), [], false);
      ex.mine();
      const ours = [...ex.orders.values()][0]!;
      ex.taker(true, 300);
      ex.mine();
      const logs = await (await fetch(ex.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x" + ex.block.toString(16), toBlock: "latest" }] }) })).json() as any;
      const trades = logs.result.map((l: any) => obIface.parseLog(l)).filter((e: any) => e.name === "Trade");
      expect(trades[0].args.makerAddress.toLowerCase()).toBe(m.address!.toLowerCase());
      expect(Number(trades[0].args.orderId)).toBe(ours.id);
      expect(String(trades[0].args.filledSize)).toBe("2000000000000");
      expect(String(trades[0].args.updatedSize)).toBe("0");
      expect(trades[1].args.makerAddress.toLowerCase()).toBe(LADDER_MAKER);
      expect(ex.margin(m.address!).usdc).toBeCloseTo(20 + 200 * (ours.priceU / 1e8), 5);
      expect(BASE_FEE).toBe(100n * 10n ** 9n);
    } finally { ex.stop(); }
  });
});
