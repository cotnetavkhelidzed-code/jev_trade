import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";
import { config } from "./config";
import { rpc } from "./chain";
import { readBook as fetchBook, readVaultParams, vaultActive, log10 } from "./book";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative MON depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

export type Side = "buy" | "sell";

/**
 * This block's order: a post-only limit order resting on Kuru's book, replacing last block's.
 * `sent` until the receipt lands, then `placed` (with its orderId) or `reverted` (the book moved
 * through the price, or a cancelled id had already filled). `lost` if no receipt ever came.
 */
export interface Quote {
  side: Side;
  price: number; // USDC per MON, tick aligned
  size: number; // MON
  txHash: string | null;
  gasMon: number; // gasLimit x gas price: Monad charges the limit, not gasUsed
  cancel: number[]; // resting order ids this tx cancels
  /** `resting`: no tx this block; the order already on the book still fits, so it stays (`txHash` is the one that placed it). */
  status: "sent" | "placed" | "reverted" | "lost" | "sim" | "resting";
  orderId: number | null;
  /** The position cap or margin funds picked this side; the model's probabilities still show its call. */
  capped: boolean;
}

/** A maker fill: someone hit one of our resting orders. Arrives via the Trade log feed, not our own receipts. */
export interface Fill {
  side: Side;
  size: number; // MON
  price: number; // USDC per MON: our order's price
  txHash: string | null; // the taker's transaction
  orderId: number;
  simulated: boolean;
}

/** `minedBlock`: the block the tx landed in (null when it never did). */
export interface QuoteResult { block: number; quote: Quote; canceled: number[]; minedBlock: number | null }

/** Margin per asset, in MON and USDC. */
export interface Margin { mon: number; usdc: number }

const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const BN = ethers.BigNumber;
const ZERO_ADDRESS = ethers.constants.AddressZero;

interface Pending { block: number; quote: Quote; gasLimit: ethers.BigNumber }

/** Kuru MON-USDC market: read the book, post one limit order per block, confirm asynchronously. */
export class Market {
  readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, config.chainId);
  /** null in a dry run (no key, or DRY_RUN=true): nothing is signed, nothing is sent. */
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  params!: Kuru.MarketParams; // public so scripts can build txs without init()
  /**
   * Free margin, what new orders can draw on: the last chain read plus every margin move of ours since
   * (Kuru locks funds when an order is placed, releases what is left when it is cancelled, and credits
   * the other asset when it fills). Re-read from the chain every `config.refreshBlocks` and after a revert.
   */
  margin: Margin = { mon: 0, usdc: 0 };
  /** The block the last chain read of the margin reflects; moves at or before it are already in it. */
  private marginAt = 0;
  private marginMoves: (Margin & { block: number })[] = [];
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private marginIface = new ethers.utils.Interface(MarginAccountAbi.abi);
  private nonce = 0;
  private feeWei = gwei(102); // base + priority, last known; Monad's floor is 100 + 2
  /** Gas for one post-only place with no cancels; a tx adds `config.gasPerCancel` per cancel (see gasLimitFor). */
  private placeGas = BN.from(config.gasLimitFallback - config.gasPerCancel);
  private useVault = false;
  private pending = new Map<string, Pending>();

  get address() { return this.wallet?.address ?? null; }
  /** Price tick in USDC per MON. */
  get tick() { return this.tickUnits / 10 ** this.priceDec; }
  private get priceDec() { return log10(this.params.pricePrecision); }
  private get sizeDec() { return log10(this.params.sizePrecision); }
  private get tickUnits() { return Number(this.params.tickSize.toString()); }

  async init() {
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    await this.refresh();
    if (!this.wallet) return;
    await this.resyncNonce();
    await this.ensureMargin();
    await this.initGasLimit();
  }

  /** Every `config.refreshBlocks`: fee estimate, margin balances, and whether the Kuru AMM vault went live. `block` is the current head. */
  async refresh(block = 0) {
    const [fee, vault] = await Promise.allSettled([
      rpc<string>("eth_gasPrice"),
      readVaultParams(config.readRpcUrl, config.market),
      this.refreshMargin(block),
    ]);
    if (fee.status === "fulfilled") this.feeWei = BN.from(fee.value);
    if (vault.status === "fulfilled") this.useVault = vaultActive(vault.value);
  }

  /**
   * Re-read the margin balances as of `block`, then re-apply our own moves from later blocks.
   * If that state is unavailable, keep the existing ledger: a latest-state fallback could already
   * include those later moves and applying them again would double-count available funds.
   */
  async refreshMargin(block = 0) {
    if (!this.wallet) return;
    const read = (tag: string) => Promise.all([this.marginBalance(ZERO_ADDRESS, tag), this.marginBalance(this.params.quoteAssetAddress, tag)]);
    const [mon, usdc] = await read(block ? "0x" + block.toString(16) : "latest");
    this.marginMoves = this.marginMoves.filter((m) => m.block > block);
    this.margin = {
      mon: Number(ethers.utils.formatUnits(mon, this.params.baseAssetDecimals.toNumber())) + this.marginMoves.reduce((s, m) => s + m.mon, 0),
      usdc: Number(ethers.utils.formatUnits(usdc, this.params.quoteAssetDecimals.toNumber())) + this.marginMoves.reduce((s, m) => s + m.usdc, 0),
    };
    this.marginAt = block;
  }

  /** Book one of our own margin moves, from a receipt or a fill in `block` (null: apply now). Skipped if the last read already has it. */
  moveMargin(block: number | null, mon: number, usdc: number) {
    if (block !== null && block <= this.marginAt) return;
    this.margin.mon += mon;
    this.margin.usdc += usdc;
    if (block !== null) this.marginMoves.push({ block, mon, usdc });
  }

  /**
   * Remaining size (MON) of our orders on the book, read from `s_orders`: 0 once an order is filled or
   * cancelled (or is not ours). One eth_call per id, off the hot path.
   */
  async orderSizes(ids: number[]): Promise<Map<number, number>> {
    const me = this.wallet?.address.toLowerCase();
    const out = new Map<number, number>(ids.map(id => [id, 0]));
    await Promise.all(ids.map(async (id) => {
      const res = await rpc<string>("eth_call", [{ to: config.market, data: this.iface.encodeFunctionData("s_orders", [id]) }, "latest"], config.readRpcUrl);
      const o = this.iface.decodeFunctionResult("s_orders", res);
      const ours = String(o.ownerAddress).toLowerCase() === me;
      out.set(id, ours ? Number(ethers.utils.formatUnits(o.size, this.sizeDec)) : 0);
    }));
    return out;
  }

  /** One eth_call (two batched into one HTTP request once the vault is live). */
  readBook(): Promise<Book> {
    return fetchBook(config.readRpcUrl, config.market, this.params, { vault: this.useVault });
  }

  /**
   * Where this block's order rests: `quoteInsideTicks` inside the touch on our side, never crossing.
   * If the spread is too tight to step inside, join the touch. Integer tick math, so the price is
   * exactly representable on-chain.
   */
  quotePrice(side: Side, book: Book): number {
    const scale = 10 ** this.priceDec, tick = this.tickUnits;
    const bidU = Math.round(book.bid * scale), askU = Math.round(book.ask * scale);
    const step = config.quoteInsideTicks * tick;
    let p = side === "buy" ? bidU + step : askU - step;
    if (side === "buy" && p >= askU) p = bidU;
    if (side === "sell" && p <= bidU) p = askU;
    return p / scale;
  }

  /**
   * Sign and fire one `batchUpdate`: cancel the given resting orders, post one new post-only limit
   * order. Returns as soon as the RPC has the hash. `pollPending` resolves placed/reverted later.
   */
  async send(block: number, side: Side, sizeMon: number, book: Book, cancel: number[], capped: boolean, priceOverride?: number): Promise<Quote> {
    const price = priceOverride ?? this.quotePrice(side, book);
    if (!this.wallet) return { side, price, size: sizeMon, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };

    const tx = this.buildTx(side, sizeMon, price, cancel);
    const signed = await this.wallet.signTransaction(tx);
    let hash: string;
    try {
      hash = await rpc<string>("eth_sendRawTransaction", [signed]);
      this.nonce++;
    } catch (e) {
      await this.resyncNonce().catch(() => {});
      throw e;
    }
    const gasLimit = BN.from(tx.gasLimit);
    const quote: Quote = { side, price, size: sizeMon, txHash: hash, gasMon: this.gasMon(gasLimit, this.feeWei), cancel, status: "sent", orderId: null, capped };
    this.pending.set(hash, { block, quote, gasLimit });
    return quote;
  }

  estimatedGasUsd(mid: number, cancels = 1) { return this.gasMon(this.gasLimitFor(cancels), this.feeWei) * mid; }
  // This integration targets the legacy Kuru contract: positive makerFeeBps is a rebate.
  get makerFeeBps() { return config.makerFeeBpsOverride ?? -Number(this.params.makerFeeBps.toString()); }
  async accountSnapshot(block: number, orders: { id: number; side: Side; price: number }[]) {
    if (!this.wallet) return null;
    const tag = "0x" + block.toString(16), owner = this.wallet.address;
    const call = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, tag], config.readRpcUrl);
    const token = new ethers.utils.Interface(ERC20_ABI);
    const [native, usd, baseMargin, quoteMargin, locked] = await Promise.all([
      rpc<string>("eth_getBalance", [owner, tag], config.readRpcUrl),
      call(this.params.quoteAssetAddress, token.encodeFunctionData("balanceOf", [owner])),
      this.marginBalance(ZERO_ADDRESS, tag), this.marginBalance(this.params.quoteAssetAddress, tag),
      Promise.all(orders.map(async o => {
        const raw = await call(config.market, this.iface.encodeFunctionData("s_orders", [o.id]));
        const result = this.iface.decodeFunctionResult("s_orders", raw);
        const size = String(result.ownerAddress).toLowerCase() === owner.toLowerCase() ? Number(ethers.utils.formatUnits(result.size, this.sizeDec)) : 0;
        return { ...o, size };
      })),
    ]);
    return { block, mon: Number(ethers.utils.formatEther(native)) + Number(ethers.utils.formatUnits(baseMargin, this.params.baseAssetDecimals.toNumber())) + locked.filter(o => o.side === "sell").reduce((a, o) => a + o.size, 0), usdc: Number(ethers.utils.formatUnits(usd, this.params.quoteAssetDecimals.toNumber())) + Number(ethers.utils.formatUnits(quoteMargin, this.params.quoteAssetDecimals.toNumber())) + locked.filter(o => o.side === "buy").reduce((a, o) => a + o.size * o.price, 0) };
  }
  get minOrderMon() { return Number(this.params.minSize.toString()) / Number(this.params.sizePrecision.toString()); }

  /** One eth_getTransactionReceipt per in-flight tx. Returns whatever resolved (or timed out). */
  async pollPending(block: number): Promise<QuoteResult[]> {
    if (!this.pending.size) return [];
    const out: QuoteResult[] = [];
    let lost = false;
    await Promise.all([...this.pending].map(async ([hash, p]) => {
      const receipt = await rpc<any>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (!this.pending.has(hash)) return; // an overlapping poll already resolved it
      if (receipt) {
        this.pending.delete(hash);
        out.push(this.parseReceipt(receipt, p));
      } else if (block - p.block >= config.pendingBlocks) {
        this.pending.delete(hash);
        lost = true;
        out.push({ block: p.block, quote: { ...p.quote, status: "lost", gasMon: 0 }, canceled: [], minedBlock: null });
      }
    }));
    if (lost) await this.resyncNonce().catch(() => {});
    return out;
  }

  /**
   * The gas limit for an update carrying `cancels` cancels. Monad charges the whole limit, used or not,
   * so it is sized to the tx: the startup estimate for one place plus headroom, plus a fixed amount per cancel.
   */
  gasLimitFor(cancels: number): ethers.BigNumber {
    return config.gasLimit ? BN.from(config.gasLimit) : this.placeGas.add(config.gasPerCancel * cancels);
  }

  /** The exact transaction the hot loop signs: no pre-send RPC, a gas limit sized from the startup estimate, static type-2 fees. */
  buildTx(side: Side, sizeMon: number, price: number, cancel: number[]): ethers.providers.TransactionRequest {
    return {
      type: 2, chainId: config.chainId, to: config.market, nonce: this.nonce, gasLimit: this.gasLimitFor(cancel.length),
      maxFeePerGas: gwei(config.maxFeeGwei), maxPriorityFeePerGas: gwei(config.priorityFeeGwei),
      data: this.encode(side, sizeMon, price, cancel), value: BN.from(0),
    };
  }

  /** batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly). Funds come from the margin account, so value is 0. */
  encode(side: Side, sizeMon: number, price: number, cancel: number[]): string {
    const priceU = BN.from(Math.round(price * 10 ** this.priceDec));
    const sizeU = ethers.utils.parseUnits(sizeMon.toFixed(this.sizeDec), this.sizeDec);
    const [bp, bs, sp, ss] = sizeMon === 0 ? [[], [], [], []] : side === "buy" ? [[priceU], [sizeU], [], []] : [[], [], [priceU], [sizeU]];
    return this.iface.encodeFunctionData("batchUpdate", [bp, bs, sp, ss, cancel.map((id) => BN.from(id)), true]);
  }

  /** OrderCreated for our address gives the new order id; OrdersCanceled lists what the tx removed. status 0x0: nothing changed on the book. */
  private parseReceipt(r: any, p: Pending): QuoteResult {
    if (r.effectiveGasPrice) this.feeWei = BN.from(r.effectiveGasPrice);
    const gasMon = this.gasMon(p.gasLimit, BN.from(r.effectiveGasPrice ?? this.feeWei));
    const me = this.wallet!.address.toLowerCase();
    let orderId: number | null = null;
    const canceled: number[] = [];
    if (r.status !== "0x0") {
      for (const log of r.logs ?? []) {
        let ev; try { ev = this.iface.parseLog(log); } catch { continue; }
        if (ev.name === "OrderCreated" && String(ev.args.owner).toLowerCase() === me) orderId = Number(ev.args.orderId);
        if (ev.name === "OrdersCanceled" && String(ev.args.owner).toLowerCase() === me) for (const id of ev.args.orderId) canceled.push(Number(id));
      }
    }
    const status: Quote["status"] = r.status === "0x0" ? "reverted" : "placed";
    return { block: p.block, quote: { ...p.quote, status, orderId, gasMon }, canceled, minedBlock: r.blockNumber ? parseInt(r.blockNumber, 16) : null };
  }

  /** Top the margin account up to MARGIN_MON / MARGIN_USDC. Runs once at startup, awaiting each receipt. */
  private async ensureMargin() {
    const w = this.wallet!;
    const baseDec = this.params.baseAssetDecimals.toNumber(), quoteDec = this.params.quoteAssetDecimals.toNumber();
    const [monBal, usdcBal] = await Promise.all([this.marginBalance(ZERO_ADDRESS), this.marginBalance(this.params.quoteAssetAddress)]);
    const mon = Number(ethers.utils.formatUnits(monBal, baseDec)), usdc = Number(ethers.utils.formatUnits(usdcBal, quoteDec));
    const deposit = async (token: string, amount: ethers.BigNumber, native: boolean) => {
      const tx = await w.sendTransaction({
        to: config.marginAccount, nonce: this.nonce++, value: native ? amount : BN.from(0),
        data: this.marginIface.encodeFunctionData("deposit", [w.address, token, amount]),
      });
      await tx.wait(1);
    };
    if (mon < config.marginMon) {
      const amt = ethers.utils.parseUnits((config.marginMon - mon).toFixed(6), baseDec);
      console.log(`margin: depositing ${ethers.utils.formatUnits(amt, baseDec)} MON`);
      await deposit(ZERO_ADDRESS, amt, true);
    }
    if (usdc < config.marginUsdc) {
      const token = new ethers.Contract(this.params.quoteAssetAddress, ERC20_ABI, w);
      const amt = ethers.utils.parseUnits((config.marginUsdc - usdc).toFixed(quoteDec), quoteDec);
      const have: ethers.BigNumber = await token.balanceOf(w.address);
      if (have.lt(amt)) {
        console.warn(`margin: wallet has ${ethers.utils.formatUnits(have, quoteDec)} USDC, wanted to deposit ${ethers.utils.formatUnits(amt, quoteDec)}; depositing what is there`);
      }
      const dep = have.lt(amt) ? have : amt;
      if (dep.gt(0)) {
        const allowance: ethers.BigNumber = await token.allowance(w.address, config.marginAccount);
        if (allowance.lt(dep)) { const tx = await token.approve(config.marginAccount, ethers.constants.MaxUint256, { nonce: this.nonce++ }); await tx.wait(1); }
        console.log(`margin: depositing ${ethers.utils.formatUnits(dep, quoteDec)} USDC`);
        await deposit(this.params.quoteAssetAddress, dep, false);
      }
    }
    await this.refresh();
    console.log(`margin · ${this.margin.mon.toFixed(2)} MON · ${this.margin.usdc.toFixed(2)} USDC`);
    // Asks lock MON and bids lock USDC, so each asset caps how far one way the position can go.
    const book = await this.readBook().catch(() => null);
    const longMon = book ? this.margin.usdc / book.ask : Infinity;
    if (this.margin.mon < config.maxPositionMon || longMon < config.maxPositionMon) {
      console.warn(`margin funds about ${Math.floor(this.margin.mon)} MON of selling and ${Math.floor(longMon)} MON of buying, less than MAX_POSITION_MON ${config.maxPositionMon}: when one runs out that side is skipped (capped) until fills refill it`);
    }
  }

  private async marginBalance(token: string, tag = "latest"): Promise<ethers.BigNumber> {
    const data = this.marginIface.encodeFunctionData("getBalance", [this.wallet!.address, token]);
    const res = await rpc<string>("eth_call", [{ to: config.marginAccount, data }, tag], config.readRpcUrl);
    return BN.from(res);
  }

  /**
   * One eth_estimateGas at startup for a post-only place with no cancels, plus `gasHeadroom`. Each tx
   * then adds `gasPerCancel` per cancel (gasLimitFor). Never in the hot loop. Needs margin funds to succeed.
   */
  private async initGasLimit() {
    if (!config.gasLimit) {
      try {
        const book = await this.readBook();
        const side: Side = this.margin.usdc >= config.tradeSizeMon * book.ask ? "buy" : "sell";
        const data = this.encode(side, config.tradeSizeMon, this.quotePrice(side, book), []);
        const est = await this.provider.estimateGas({ to: config.market, from: this.wallet!.address, data });
        this.placeGas = est.mul(Math.round((1 + config.gasHeadroom) * 1000)).div(1000);
      } catch (e) {
        // ethers puts the node's revert reason in `reason`; its `message` is a generic preamble.
        const why = (e as { reason?: string }).reason ?? (e as Error).message;
        console.warn(`gas estimate failed (${why.slice(0, 160)}); using ${config.gasLimitFallback}`);
      }
    }
    const perBlock = this.gasMon(this.gasLimitFor(1), this.feeWei); // a normal block: one cancel, one place
    const limit = config.gasLimit ? `${config.gasLimit} (fixed)` : `${this.placeGas} + ${config.gasPerCancel} per cancel`;
    console.log(`gas limit ${limit} · maxFee ${config.maxFeeGwei} gwei · priority ${config.priorityFeeGwei} gwei · ~${perBlock.toFixed(4)} MON per block, ~${(perBlock * 12_000).toFixed(0)} MON per hour`);
  }

  private gasMon(limit: ethers.BigNumber, feeWei: ethers.BigNumber) {
    return Number(ethers.utils.formatEther(limit.mul(feeWei)));
  }

  /**
   * A send with no receipt may still be in the mempool. Resyncing to the confirmed nonce alone would
   * sign that nonce again and get "nonce too low" every block until it clears, so take the higher of
   * confirmed and pending. If the send was dropped instead, pending equals confirmed and its nonce is reused.
   */
  private async resyncNonce() {
    const addr = this.wallet!.address;
    const [latest, pending] = await Promise.all([
      rpc<string>("eth_getTransactionCount", [addr, "latest"]),
      rpc<string>("eth_getTransactionCount", [addr, "pending"]).catch(() => "0x0"),
    ]);
    this.nonce = Math.max(parseInt(latest, 16), parseInt(pending, 16));
  }
}
