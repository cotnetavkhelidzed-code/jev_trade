/**
 * Practice exchange: a local stand-in for Monad + Kuru's MON-USDC order book, for paper trading and tests.
 *
 * Speaks the JSON-RPC subset the bot uses (HTTP, batches, WebSocket newHeads) and simulates one market:
 * a random-walk mid with drifting regimes, a synthetic maker ladder rebuilt every block, and random
 * takers (leaning with the drift, so taker flow carries signal) that walk the book best price first.
 * Signed transactions are executed the way Kuru does it: batchUpdate runs its cancels, then its post-only
 * places, against the margin account, with OrderCreated / OrdersCanceled / Trade logs, plus margin deposits
 * and USDC approvals. Gas is charged on the limit, reverts included. Nothing here touches a real chain.
 * (Cancels-before-places and the owner check on cancel were confirmed against mainnet with eth_call.)
 *
 * Each block: the mid moves and the ladder is rebuilt, resting orders the move crossed get filled,
 * pending transactions execute (so a quote the book moved through reverts, as on mainnet), then takers.
 *
 * Run: bun run scripts/practice-exchange.ts [port]
 * Then point the bot at it: RPC_URL=READ_RPC_URL=http://localhost:<port> WS_URL=ws://localhost:<port>
 */
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";

export const CHAIN_ID = 143;
export const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
export const MARGIN_ACCOUNT = "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5";
export const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const ZERO = ethers.constants.AddressZero;
/** Synthetic liquidity and the takers that hit it. */
export const LADDER_MAKER = "0x00000000000000000000000000000000000a11ce";
export const TAKER = "0x0000000000000000000000000000000000007a1e";

// Kuru MON-USDC market params, as read from mainnet.
export const PRICE_PREC = 100_000_000; // 1e8
export const TICK = 100; // 0.000001 USDC
const SIZE_PREC = 10n ** 10n;
const MIN_SIZE = 200n * SIZE_PREC;
const MAX_SIZE = 200_000_000n * SIZE_PREC;
const GWEI = 10n ** 9n;
export const BASE_FEE = 100n * GWEI; // Monad's floor
const GAS_BATCH = 282_170n, GAS_CANCEL = 25_000n, GAS_DEPOSIT = 80_000n, GAS_APPROVE = 46_000n;

const ob = new ethers.utils.Interface(OrderBookAbi.abi);
const ma = new ethers.utils.Interface(MarginAccountAbi.abi);
const erc20 = new ethers.utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);
const coder = ethers.utils.defaultAbiCoder;
const hex = (n: number | bigint) => "0x" + n.toString(16);
const lc = (a: string) => a.toLowerCase();

export interface ExchangeOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Auto-mine interval. 0: the chain only advances on mine(). */
  blockMs?: number;
  startBlock?: number;
  /** Starting mid, USDC per MON. */
  mid?: number;
  seed?: number;
  /** Per-block volatility of the mid, in bps. */
  volBps?: number;
  /** Mean random taker prints per block. */
  takersPerBlock?: number;
  /** Receipts show up this many blocks after inclusion; logs show up at once (they come from another RPC). */
  receiptLagBlocks?: number;
  /** Report an active AMM vault in getVaultParams. */
  vault?: boolean;
  market?: string;
  marginAccount?: string;
  /** What any address it has not seen before starts with in its wallet. */
  faucet?: { mon: number; usdc: number };
  /** rpc.monad.xyz rejects eth_getLogs spans over 100 blocks; so does this. */
  maxLogRange?: number;
}

export interface Order { id: number; owner: string; isBuy: boolean; priceU: number; sizeU: bigint }
interface Log { address: string; topics: string[]; data: string; blockNumber: number; transactionHash: string; logIndex: number }
interface Tx { hash: string; from: string; to: string; nonce: number; data: string; value: bigint; gasLimit: bigint; maxFee: bigint; priority: bigint }
interface Mined { tx: Tx; block: number; status: 0 | 1; logs: Log[]; gasPrice: bigint; reason?: string }
type RpcResult = { result: unknown } | { error: { code: number; message: string } };
type Override = (params: any[]) => RpcResult | undefined;

/** Signed fills of one owner against the practice book, for the end-of-run summary. */
export interface OwnerStats { fills: number; boughtMon: number; soldMon: number; paidUsdc: number; receivedUsdc: number; gasMon: number; reverted: number; placed: number; revertReasons: Record<string, number> }

export function startPracticeExchange(opts: ExchangeOptions = {}) {
  const market = lc(opts.market ?? MARKET), marginAccount = lc(opts.marginAccount ?? MARGIN_ACCOUNT), usdc = lc(USDC);
  const faucet = opts.faucet ?? { mon: 10_000, usdc: 1_000 };
  const maxLogRange = opts.maxLogRange ?? 100;
  let receiptLag = opts.receiptLagBlocks ?? 0;
  const volBps = opts.volBps ?? 0.8;
  const takersPerBlock = opts.takersPerBlock ?? 0.6;

  // mulberry32: deterministic for a given seed
  let seed = (opts.seed ?? 42) >>> 0;
  const rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  let block = opts.startBlock ?? 117_000_000;
  let mid = opts.mid ?? 0.0236;
  let drift = 0; // bps per block, re-drawn now and then
  let nextOrderId = 100_300_000, txCounter = 0;
  let bids: [number, bigint][] = [], asks: [number, bigint][] = []; // synthetic ladder: bids best first (desc), asks best first (asc)
  const orders = new Map<number, Order>(); // resting orders placed through transactions
  const logs: Log[] = [];
  const mempool: Tx[] = [];
  const mined = new Map<string, Mined>();
  const nonces = new Map<string, number>();
  const native = new Map<string, bigint>(), usdcBal = new Map<string, bigint>(), allowance = new Map<string, bigint>();
  const margin = new Map<string, bigint>(); // `${user}:${token}`
  const stats = new Map<string, OwnerStats>();
  const scheduledTakers: { isBuy: boolean; sizeU: bigint }[] = [];
  const overrides = new Map<string, Override>();
  const requests = new Map<string, number>();
  const sockets = new Set<{ send(s: string): void }>();
  const seen = new Set<string>();

  const touch = (a: string) => {
    a = lc(a);
    if (seen.has(a)) return a;
    seen.add(a);
    native.set(a, ethers.utils.parseEther(String(faucet.mon)).toBigInt());
    usdcBal.set(a, BigInt(Math.round(faucet.usdc * 1e6)));
    return a;
  };
  const statsOf = (a: string) => {
    let s = stats.get(a);
    if (!s) stats.set(a, (s = { fills: 0, boughtMon: 0, soldMon: 0, paidUsdc: 0, receivedUsdc: 0, gasMon: 0, reverted: 0, placed: 0, revertReasons: {} }));
    return s;
  };
  const marginKey = (user: string, token: string) => `${lc(user)}:${lc(token)}`;
  const marginOf = (user: string, token: string) => margin.get(marginKey(user, token)) ?? 0n;
  const addMargin = (user: string, token: string, d: bigint) => margin.set(marginKey(user, token), marginOf(user, token) + d);
  /** USDC (6 dp) a bid of `sizeU` at `priceU` locks, rounded up. */
  const usdcFor = (sizeU: bigint, priceU: number) => (sizeU * BigInt(priceU) * 10n ** 6n + 10n ** 18n - 1n) / 10n ** 18n;
  const monFor = (sizeU: bigint) => sizeU * 10n ** 8n; // 1e10 size units -> 1e18 wei

  // ---------------------------------------------------------------------------------------------
  // Book

  function rebuildLadder() {
    const midU = mid * PRICE_PREC;
    const spreadTicks = randInt(3, 14);
    const bestBid = Math.max(TICK, Math.floor((midU - (spreadTicks * TICK) / 2) / TICK) * TICK);
    const bestAsk = bestBid + spreadTicks * TICK;
    bids = []; asks = [];
    let b = bestBid, a = bestAsk;
    for (let i = 0; i < 15; i++) {
      bids.push([b, BigInt(randInt(300, 8000)) * SIZE_PREC]);
      asks.push([a, BigInt(randInt(300, 8000)) * SIZE_PREC]);
      b -= randInt(1, 3) * TICK; a += randInt(1, 3) * TICK;
      if (b <= 0) break;
    }
  }

  const ours = (isBuy: boolean) => [...orders.values()].filter((o) => o.isBuy === isBuy);
  const bestBidU = () => Math.max(bids[0]?.[0] ?? 0, ...ours(true).map((o) => o.priceU));
  const bestAskU = () => Math.min(asks[0]?.[0] ?? Infinity, ...ours(false).map((o) => o.priceU));

  /** getL2Book() return data: offset, length, then block, bids (desc), a zero word, asks (asc). */
  function l2Hex(): string {
    const merge = (side: [number, bigint][], isBuy: boolean) => {
      const m = new Map<number, bigint>();
      for (const [p, s] of side) m.set(p, (m.get(p) ?? 0n) + s);
      for (const o of ours(isBuy)) m.set(o.priceU, (m.get(o.priceU) ?? 0n) + o.sizeU);
      return [...m.entries()].sort((x, y) => (isBuy ? y[0] - x[0] : x[0] - y[0]));
    };
    const words: bigint[] = [BigInt(block)];
    for (const [p, s] of merge(bids, true)) words.push(BigInt(p), s);
    words.push(0n);
    for (const [p, s] of merge(asks, false)) words.push(BigInt(p), s);
    const payload = "0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("");
    return coder.encode(["bytes"], [payload]);
  }

  // ---------------------------------------------------------------------------------------------
  // Logs

  let logIndex = 0;
  const pushLog = (event: string, values: unknown[], txHash: string): Log => {
    const enc = ob.encodeEventLog(ob.getEvent(event), values);
    const log = { address: market, topics: enc.topics, data: enc.data, blockNumber: block, transactionHash: txHash, logIndex: logIndex++ };
    logs.push(log);
    return log;
  };
  const fakeHash = () => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`practice:${block}:${txCounter++}`));

  /** A taker hits `o` (ours or the ladder's) for `fillU`. Ours: credit the proceeds to margin. */
  function trade(orderId: number, maker: string, takerIsBuy: boolean, priceU: number, fillU: bigint, remainingU: bigint, txHash: string) {
    pushLog("Trade", [orderId, maker, takerIsBuy, BigInt(priceU) * 10n ** 10n, remainingU, TAKER, TAKER, fillU], txHash);
    if (maker === LADDER_MAKER) return;
    const s = statsOf(maker), mon = Number(fillU) / 1e10, usd = (Number(fillU) / 1e10) * (priceU / PRICE_PREC);
    s.fills++;
    if (takerIsBuy) { addMargin(maker, usdc, (fillU * BigInt(priceU)) / 10n ** 12n); s.soldMon += mon; s.receivedUsdc += usd; }
    else { addMargin(maker, ZERO, monFor(fillU)); s.boughtMon += mon; s.paidUsdc += usd; }
  }

  /** Walk the book best price first. At one price our resting orders (older) go before the fresh ladder. */
  function taker(isBuy: boolean, sizeU: bigint) {
    const txHash = fakeHash();
    let left = sizeU;
    const ladder = isBuy ? asks : bids;
    const better = (a: number, b: number) => (isBuy ? a < b : a > b);
    while (left > 0n) {
      const mine = ours(!isBuy).sort((a, b) => (isBuy ? a.priceU - b.priceU : b.priceU - a.priceU) || a.id - b.id)[0];
      const lvl = ladder[0];
      if (!mine && !lvl) break;
      if (mine && (!lvl || !better(lvl[0], mine.priceU))) {
        const f = left < mine.sizeU ? left : mine.sizeU;
        mine.sizeU -= f; left -= f;
        if (mine.sizeU === 0n) orders.delete(mine.id);
        trade(mine.id, mine.owner, isBuy, mine.priceU, f, mine.sizeU, txHash);
      } else {
        const f = left < lvl![1] ? left : lvl![1];
        lvl![1] -= f; left -= f;
        trade(nextOrderId++, LADDER_MAKER, isBuy, lvl![0], f, lvl![1], txHash);
        if (lvl![1] === 0n) ladder.shift();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Transactions

  /** Validate a batchUpdate without touching state. Returns the revert reason, or a function that applies it. */
  function planBatch(from: string, args: ethers.utils.Result): { error: string } | { apply: (txHash: string) => Log[] } {
    const [buyPrices, buySizes, sellPrices, sellSizes, cancelIds, postOnly] = args as unknown as [number[], ethers.BigNumber[], number[], ethers.BigNumber[], ethers.BigNumber[], boolean];
    const cancels = cancelIds.map((x) => Number(x));
    let refundUsdc = 0n, refundMon = 0n;
    for (const id of cancels) {
      // Kuru deletes an order once it is filled or cancelled, so cancelling it again fails the owner check (checked on mainnet).
      const o = orders.get(id);
      if (!o || o.owner !== from) return { error: `OnlyOwnerAllowedError(${id})` };
      if (o.isBuy) refundUsdc += usdcFor(o.sizeU, o.priceU); else refundMon += monFor(o.sizeU);
    }
    const remaining = [...orders.values()].filter((o) => !cancels.includes(o.id));
    const bestAsk = Math.min(asks[0]?.[0] ?? Infinity, ...remaining.filter((o) => !o.isBuy).map((o) => o.priceU));
    const bestBid = Math.max(bids[0]?.[0] ?? 0, ...remaining.filter((o) => o.isBuy).map((o) => o.priceU));
    const places: { isBuy: boolean; priceU: number; sizeU: bigint }[] = [];
    buyPrices.forEach((p, i) => places.push({ isBuy: true, priceU: Number(p), sizeU: buySizes[i]!.toBigInt() }));
    sellPrices.forEach((p, i) => places.push({ isBuy: false, priceU: Number(p), sizeU: sellSizes[i]!.toBigInt() }));
    let needUsdc = 0n, needMon = 0n;
    for (const o of places) {
      if (o.priceU % TICK !== 0) return { error: "TickSizeError" };
      if (o.sizeU < MIN_SIZE || o.sizeU > MAX_SIZE) return { error: "SizeError" };
      if (postOnly && (o.isBuy ? o.priceU >= bestAsk : o.priceU <= bestBid)) return { error: "PostOnlyError" };
      if (o.isBuy) needUsdc += usdcFor(o.sizeU, o.priceU); else needMon += monFor(o.sizeU);
    }
    if (marginOf(from, usdc) + refundUsdc < needUsdc || marginOf(from, ZERO) + refundMon < needMon) return { error: "InsufficientBalance" };
    return {
      apply: (txHash) => {
        const out: Log[] = [];
        for (const id of cancels) orders.delete(id);
        addMargin(from, usdc, refundUsdc - needUsdc);
        addMargin(from, ZERO, refundMon - needMon);
        if (cancels.length) out.push(pushLog("OrdersCanceled", [cancels, from], txHash));
        for (const o of places) {
          const id = nextOrderId++;
          orders.set(id, { id, owner: from, ...o });
          statsOf(from).placed++;
          out.push(pushLog("OrderCreated", [id, from, o.sizeU, o.priceU, o.isBuy], txHash));
        }
        return out;
      },
    };
  }

  /** Same dispatch for eth_estimateGas, eth_call-style dry runs and mined execution. */
  function plan(from: string, to: string, data: string, value: bigint): { error: string } | { gas: bigint; apply: (txHash: string) => Log[] } {
    to = lc(to);
    try {
      if (to === market) {
        const d = ob.parseTransaction({ data, value });
        if (d.name !== "batchUpdate") return { error: `unsupported ${d.name}` };
        const p = planBatch(from, d.args);
        return "error" in p ? p : { gas: GAS_BATCH + GAS_CANCEL * BigInt(d.args[4].length), apply: p.apply };
      }
      if (to === marginAccount) {
        const d = ma.parseTransaction({ data, value });
        if (d.name !== "deposit") return { error: `unsupported ${d.name}` };
        const [user, token, amount] = [lc(d.args[0]), lc(d.args[1]), (d.args[2] as ethers.BigNumber).toBigInt()];
        if (token === ZERO) {
          if (value !== amount) return { error: "NativeAssetMismatch" };
        } else if (token === usdc) {
          if ((allowance.get(`${from}:${marginAccount}`) ?? 0n) < amount) return { error: "ERC20: insufficient allowance" };
          if ((usdcBal.get(from) ?? 0n) < amount) return { error: "ERC20: transfer amount exceeds balance" };
        } else return { error: "TokenNotSupported" };
        return {
          gas: GAS_DEPOSIT,
          apply: () => {
            if (token === usdc) {
              usdcBal.set(from, usdcBal.get(from)! - amount);
              allowance.set(`${from}:${marginAccount}`, allowance.get(`${from}:${marginAccount}`)! - amount);
            }
            addMargin(user, token, amount);
            return [];
          },
        };
      }
      if (to === usdc) {
        const d = erc20.parseTransaction({ data, value });
        if (d.name !== "approve") return { error: `unsupported ${d.name}` };
        return { gas: GAS_APPROVE, apply: () => { allowance.set(`${from}:${lc(d.args[0])}`, (d.args[1] as ethers.BigNumber).toBigInt()); return []; } };
      }
    } catch (e) {
      return { error: `bad calldata: ${(e as Error).message.slice(0, 80)}` };
    }
    return { error: "no contract at " + to };
  }

  function execute(tx: Tx) {
    const gasPrice = BASE_FEE + (tx.priority < tx.maxFee - BASE_FEE ? tx.priority : tx.maxFee - BASE_FEE);
    native.set(tx.from, native.get(tx.from)! - tx.gasLimit * gasPrice); // Monad charges the limit
    nonces.set(tx.from, (nonces.get(tx.from) ?? 0) + 1);
    const p = plan(tx.from, tx.to, tx.data, tx.value);
    const s = statsOf(tx.from);
    s.gasMon += Number(tx.gasLimit * gasPrice) / 1e18;
    const reason = "error" in p ? p.error : p.gas > tx.gasLimit ? "out of gas" : undefined;
    let out: Log[] = [];
    if (!reason && "apply" in p) {
      native.set(tx.from, native.get(tx.from)! - tx.value);
      out = p.apply(tx.hash);
    } else {
      s.reverted++;
      const why = reason!.replace(/\(.*$/, "");
      s.revertReasons[why] = (s.revertReasons[why] ?? 0) + 1;
    }
    mined.set(tx.hash, { tx, block, status: reason ? 0 : 1, logs: out, gasPrice, reason });
  }

  // ---------------------------------------------------------------------------------------------
  // Blocks

  function mine() {
    block++;
    logIndex = 0;
    if (rand() < 1 / 150) drift = gauss() * 0.25;
    mid = Math.max(0.001, mid * Math.exp(((drift + volBps * gauss()) / 10_000)));
    rebuildLadder();
    // Resting orders the move went through: an arbitrageur takes them at our price.
    for (const o of [...orders.values()]) {
      const crossed = o.isBuy ? o.priceU >= asks[0]![0] : o.priceU <= bids[0]![0];
      if (crossed) { const f = o.sizeU; orders.delete(o.id); trade(o.id, o.owner, !o.isBuy, o.priceU, f, 0n, fakeHash()); }
    }
    for (const tx of mempool.splice(0)) execute(tx);
    for (const t of scheduledTakers.splice(0)) taker(t.isBuy, t.sizeU);
    let k = 0; const L = Math.exp(-takersPerBlock); let p = rand();
    while (p > L) { k++; p *= rand(); } // Poisson(takersPerBlock)
    for (let i = 0; i < k; i++) {
      const pBuy = Math.min(0.85, Math.max(0.15, 0.5 + drift * 0.8));
      taker(rand() < pBuy, BigInt(randInt(200, 2500)) * SIZE_PREC);
    }
    const head = JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0x1", result: { number: hex(block), hash: blockHash(block), timestamp: hex(Math.floor(Date.now() / 1000)) } } });
    for (const s of sockets) s.send(head);
  }
  const blockHash = (n: number) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`block:${n}`));

  // ---------------------------------------------------------------------------------------------
  // JSON-RPC

  const err = (code: number, message: string): RpcResult => ({ error: { code, message } });
  const receiptOf = (m: Mined) => ({
    transactionHash: m.tx.hash, transactionIndex: "0x0", blockHash: blockHash(m.block), blockNumber: hex(m.block),
    from: m.tx.from, to: m.tx.to, contractAddress: null, cumulativeGasUsed: hex(m.tx.gasLimit), gasUsed: hex(m.tx.gasLimit),
    effectiveGasPrice: hex(m.gasPrice), status: m.status ? "0x1" : "0x0", type: "0x2", logsBloom: "0x" + "00".repeat(256),
    logs: m.logs.map(logJson),
  });
  const logJson = (l: Log) => ({
    address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.blockNumber), blockHash: blockHash(l.blockNumber),
    transactionHash: l.transactionHash, transactionIndex: "0x0", logIndex: hex(l.logIndex), removed: false,
  });
  const tag = (t: unknown) => (t === "latest" || t === "pending" || t === undefined ? block : t === "earliest" ? 0 : parseInt(String(t), 16));
  const pendingFrom = (a: string) => mempool.filter((t) => t.from === a).length;

  function call(to: string, data: string): RpcResult {
    to = lc(to);
    const sel = data.slice(0, 10);
    if (to === market) {
      if (sel === ob.getSighash("getL2Book")) return { result: l2Hex() };
      if (sel === ob.getSighash("getVaultParams")) {
        const v = opts.vault
          ? ["0x838c2d3fD4DB5eB2F185cbE7697fbaAce52b34d7", BigInt(Math.round(mid * 0.9995 * 1e18)), 0n, BigInt(Math.round(mid * 1.0005 * 1e18)), 0n, 5000n * SIZE_PREC, 4800n * SIZE_PREC, 30n]
          : ["0x838c2d3fD4DB5eB2F185cbE7697fbaAce52b34d7", BigInt(Math.round(mid * 0.9997 * 1e18)), 0n, BigInt(Math.round(mid * 1.0003 * 1e18)), 0n, 0n, 0n, 30n];
        return { result: ob.encodeFunctionResult("getVaultParams", v) };
      }
      if (sel === ob.getSighash("getMarketParams")) {
        return { result: ob.encodeFunctionResult("getMarketParams", [PRICE_PREC, SIZE_PREC, ZERO, 18, USDC, 6, TICK, MIN_SIZE, MAX_SIZE, 0, 0]) };
      }
      if (sel === ob.getSighash("bestBidAsk")) return { result: ob.encodeFunctionResult("bestBidAsk", [bestBidU(), bestAskU()]) };
      if (sel === ob.getSighash("s_orders")) {
        const o = orders.get(Number(ob.decodeFunctionData("s_orders", data)[0]));
        return { result: ob.encodeFunctionResult("s_orders", o ? [o.owner, o.sizeU, 0, 0, 0, o.priceU, 0, o.isBuy] : [ZERO, 0, 0, 0, 0, 0, 0, false]) };
      }
    }
    if (to === marginAccount && sel === ma.getSighash("getBalance")) {
      const [user, token] = ma.decodeFunctionData("getBalance", data);
      return { result: coder.encode(["uint256"], [marginOf(user, token)]) };
    }
    if (to === usdc) {
      if (sel === erc20.getSighash("balanceOf")) return { result: coder.encode(["uint256"], [usdcBal.get(touch(erc20.decodeFunctionData("balanceOf", data)[0])) ?? 0n]) };
      if (sel === erc20.getSighash("allowance")) {
        const [o, s] = erc20.decodeFunctionData("allowance", data);
        return { result: coder.encode(["uint256"], [allowance.get(`${lc(o)}:${lc(s)}`) ?? 0n]) };
      }
      if (sel === erc20.getSighash("decimals")) return { result: coder.encode(["uint8"], [6]) };
    }
    return err(3, "execution reverted");
  }

  function handle(method: string, params: any[]): RpcResult {
    requests.set(method, (requests.get(method) ?? 0) + 1);
    const o = overrides.get(method)?.(params);
    if (o) return o;
    switch (method) {
      case "eth_chainId": return { result: hex(CHAIN_ID) };
      case "net_version": return { result: String(CHAIN_ID) };
      case "eth_blockNumber": return { result: hex(block) };
      case "eth_gasPrice": return { result: hex(BASE_FEE + 2n * GWEI) };
      case "eth_maxPriorityFeePerGas": return { result: hex(2n * GWEI) };
      case "eth_getBlockByNumber": {
        const n = tag(params[0]);
        return { result: {
          number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: hex(Math.floor(Date.now() / 1000)),
          nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: hex(150_000_000), gasUsed: "0x0", miner: ZERO,
          extraData: "0x", baseFeePerGas: hex(BASE_FEE), transactions: [],
        } };
      }
      case "eth_getBalance": return { result: hex(native.get(touch(params[0])) ?? 0n) };
      case "eth_getTransactionCount": {
        const a = touch(params[0]);
        return { result: hex((nonces.get(a) ?? 0) + (params[1] === "pending" ? pendingFrom(a) : 0)) };
      }
      case "eth_call": return call(params[0].to, params[0].data ?? params[0].input ?? "0x");
      case "eth_estimateGas": {
        const p = plan(touch(params[0].from ?? ZERO), params[0].to, params[0].data ?? "0x", BigInt(params[0].value ?? 0));
        return "error" in p ? err(3, `execution reverted: ${p.error}`) : { result: hex(p.gas) };
      }
      case "eth_sendRawTransaction": {
        let t: ethers.Transaction;
        try { t = ethers.utils.parseTransaction(params[0]); } catch { return err(-32602, "invalid raw transaction"); }
        if (t.chainId !== CHAIN_ID) return err(-32000, `invalid chain id ${t.chainId}`);
        if (t.type !== 2) return err(-32000, "only type-2 transactions in practice mode");
        const from = touch(t.from!);
        const expected = (nonces.get(from) ?? 0) + pendingFrom(from);
        if (t.nonce < expected) return err(-32000, "nonce too low");
        if (t.nonce > expected) return err(-32000, "nonce too high");
        const maxFee = t.maxFeePerGas!.toBigInt(), gasLimit = t.gasLimit.toBigInt(), value = t.value.toBigInt();
        if (maxFee < BASE_FEE) return err(-32000, "max fee per gas less than block base fee");
        if ((native.get(from) ?? 0n) < gasLimit * maxFee + value) return err(-32000, "insufficient funds for gas * price + value");
        if (mined.has(t.hash!) || mempool.some((m) => m.hash === t.hash)) return err(-32000, "already known");
        mempool.push({ hash: t.hash!, from, to: t.to!, nonce: t.nonce, data: t.data, value, gasLimit, maxFee, priority: t.maxPriorityFeePerGas!.toBigInt() });
        return { result: t.hash };
      }
      case "eth_getTransactionReceipt": {
        const m = mined.get(params[0]);
        return { result: m && block >= m.block + receiptLag ? receiptOf(m) : null };
      }
      case "eth_getTransactionByHash": {
        const m = mined.get(params[0]);
        const t = m?.tx ?? mempool.find((x) => x.hash === params[0]);
        if (!t) return { result: null };
        return { result: {
          hash: t.hash, from: t.from, to: t.to, nonce: hex(t.nonce), input: t.data, value: hex(t.value), gas: hex(t.gasLimit), type: "0x2",
          maxFeePerGas: hex(t.maxFee), maxPriorityFeePerGas: hex(t.priority), chainId: hex(CHAIN_ID), v: "0x0", r: "0x0", s: "0x0",
          blockNumber: m ? hex(m.block) : null, blockHash: m ? blockHash(m.block) : null, transactionIndex: m ? "0x0" : null,
        } };
      }
      case "eth_getLogs": {
        const f = params[0] ?? {};
        const from = tag(f.fromBlock), to = tag(f.toBlock);
        if (to - from + 1 > maxLogRange) return err(-32614, `eth_getLogs is limited to a ${maxLogRange} range`);
        const addrs = f.address ? [f.address].flat().map(lc) : null;
        const topic0 = f.topics?.[0] ? [f.topics[0]].flat().map(lc) : null;
        return { result: logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!addrs || addrs.includes(l.address)) && (!topic0 || topic0.includes(lc(l.topics[0]!)))).map(logJson) };
      }
      default: return err(-32601, `method ${method} not supported by the practice exchange`);
    }
  }

  const answer = (req: any) => ({ jsonrpc: "2.0", id: req?.id ?? null, ...handle(String(req?.method), Array.isArray(req?.params) ? req.params : []) });

  rebuildLadder();
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req, srv) {
      if (req.headers.get("upgrade") === "websocket") return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
      // No keep-alive: clients must not reuse a pooled socket after this exchange stops and a new one takes the port.
      const headers = { connection: "close" };
      if (req.method === "GET") return Response.json(status(), { headers });
      const body = await req.json().catch(() => null);
      if (body === null) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { headers });
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body), { headers });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, msg) {
        const req = JSON.parse(String(msg));
        ws.send(JSON.stringify(req.method === "eth_subscribe" ? { jsonrpc: "2.0", id: req.id, result: "0x1" } : answer(req)));
      },
    },
  });

  const timer = opts.blockMs ? setInterval(mine, opts.blockMs) : null;

  function status() {
    return {
      block, mid: Number(mid.toFixed(6)), bestBid: bestBidU() / PRICE_PREC, bestAsk: bestAskU() / PRICE_PREC,
      resting: [...orders.values()].map((o) => ({ id: o.id, owner: o.owner, side: o.isBuy ? "buy" : "sell", price: o.priceU / PRICE_PREC, size: Number(o.sizeU) / 1e10 })),
      traders: Object.fromEntries([...stats].map(([a, s]) => [a, { ...s, marginMon: Number(marginOf(a, ZERO)) / 1e18, marginUsdc: Number(marginOf(a, usdc)) / 1e6 }])),
      requests: Object.fromEntries(requests),
    };
  }

  return {
    url: `http://localhost:${server.port}`,
    wsUrl: `ws://localhost:${server.port}`,
    get block() { return block; },
    get mid() { return mid; },
    set mid(m: number) { mid = m; rebuildLadder(); },
    /** Best synthetic (ladder only) bid/ask in price units. */
    get ladder() { return { bid: bids[0]![0], ask: asks[0]![0] }; },
    orders,
    mine,
    /** Queue a taker for the next block (before the random ones). */
    taker: (isBuy: boolean, sizeMon: number) => scheduledTakers.push({ isBuy, sizeU: BigInt(Math.round(sizeMon * 1e10)) }),
    /** Answer `method` with `fn` while it returns a result; undefined falls through to the simulator. */
    override: (method: string, fn: Override | null) => (fn ? overrides.set(method, fn) : overrides.delete(method)),
    setReceiptLag: (n: number) => { receiptLag = n; },
    margin: (user: string) => ({ mon: Number(marginOf(user, ZERO)) / 1e18, usdc: Number(marginOf(user, usdc)) / 1e6 }),
    setMargin: (user: string, mon: number, usdcAmt: number) => {
      margin.set(marginKey(user, ZERO), ethers.utils.parseEther(String(mon)).toBigInt());
      margin.set(marginKey(user, usdc), BigInt(Math.round(usdcAmt * 1e6)));
    },
    receipt: (hash: string) => mined.get(hash),
    requests,
    stats: (a: string) => statsOf(lc(a)),
    status,
    stop() { if (timer) clearInterval(timer); for (const s of sockets) (s as any).close?.(); server.stop(true); },
  };
}

export type PracticeExchange = ReturnType<typeof startPracticeExchange>;

if (import.meta.main) {
  const port = Number(process.argv[2] ?? process.env.PRACTICE_PORT ?? 8545);
  // FAUCET_MON / FAUCET_USDC: what a new wallet starts with (default 10,000 MON and 1,000 USDC).
  const faucet = { mon: Number(process.env.FAUCET_MON ?? 10_000), usdc: Number(process.env.FAUCET_USDC ?? 1_000) };
  const ex = startPracticeExchange({ port, blockMs: 300, seed: Number(process.env.SEED ?? Date.now() % 1e9), faucet });
  console.log(`practice exchange: Kuru MON-USDC simulator on ${ex.url} (ws ${ex.wsUrl}), 300 ms blocks, mid ${ex.mid}, new wallets get ${faucet.mon} MON + ${faucet.usdc} USDC`);
  console.log(`run the bot against it: RPC_URL=${ex.url} READ_RPC_URL=${ex.url} WS_URL=${ex.wsUrl} bun run start`);
  setInterval(() => {
    const s = ex.status();
    const t = Object.entries(s.traders).map(([a, x]) => `${a.slice(0, 8)} placed ${x.placed} fills ${x.fills} bought ${x.boughtMon.toFixed(0)} sold ${x.soldMon.toFixed(0)} reverted ${x.reverted} ${JSON.stringify(x.revertReasons)} gas ${x.gasMon.toFixed(3)} MON margin ${x.marginMon.toFixed(1)} MON ${x.marginUsdc.toFixed(2)} USDC`).join(" | ");
    console.log(`block ${s.block} mid ${s.mid.toFixed(6)} bid ${s.bestBid.toFixed(6)} ask ${s.bestAsk.toFixed(6)} ${t}`);
  }, 10_000);
}
