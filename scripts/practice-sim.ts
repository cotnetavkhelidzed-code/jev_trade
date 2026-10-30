/**
 * Fast practice run: the real bot (Market, Trader, MODEL=mock or jev) against an in-process practice exchange,
 * one block after another as fast as they go, then what the account is worth against what it started
 * with and against just holding the starting coins.
 *
 * Run: BLOCKS=12000 SEED=50 START_MON=1350 START_USDC=18 MARGIN_MON=750 MARGIN_USDC=18 bun run scripts/practice-sim.ts
 * BLOCKS defaults to 12000 (one hour of 300 ms blocks). START_MON / START_USDC fund the wallet; the rest
 * are the bot's usual settings (TRADE_SIZE_MON, MARGIN_MON, MARGIN_USDC, MAX_POSITION_MON, GAS_*, ...).
 * The mock model keeps a latency (MOCK_LATENCY_MS, default 20) so receipts and trade logs arrive in the
 * same order relative to each decision as in a live run. Prints one JSON line (prefixed RESULT) at the end.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { startPracticeExchange } from "./practice-exchange";

const blocks = Number(process.env.BLOCKS ?? 12_000);
const seed = Number(process.env.SEED ?? 50);
const start = { mon: Number(process.env.START_MON ?? 1350), usdc: Number(process.env.START_USDC ?? 18) };
const latency = Number(process.env.MOCK_LATENCY_MS ?? 20);

if (process.env.MODEL === "jev" && !process.env.TYPESAFE_AI_API_KEY?.trim()) {
  throw new Error("MODEL=jev requires TYPESAFE_AI_API_KEY for a Jev practice run");
}

const ex = startPracticeExchange({ seed, faucet: start });
// Config reads the environment once, on import: set it first, then import the bot.
Object.assign(process.env, { RPC_URL: ex.url, READ_RPC_URL: ex.url, PRIVATE_KEY: ethers.Wallet.createRandom().privateKey, DRY_RUN: "false" });
delete process.env.WS_URL;
process.chdir(mkdtempSync(join(tmpdir(), "jev-sim-"))); // the trader appends to ./data/events.jsonl
const { config } = await import("../src/config");
const { Market } = await import("../src/market");
const { Trader } = await import("../src/trader");
const { createModel } = await import("../src/model");
const { log10 } = await import("../src/book");

const realSleep = Bun.sleep;
(Bun as { sleep: typeof Bun.sleep }).sleep = ((ms: number | Date) => realSleep(ms === 80 ? latency : ms)) as typeof Bun.sleep; // the mock's 80 ms

const quiet = process.env.VERBOSE ? console.log : () => {};
const log = console.log;
console.log = quiet;
const market = new Market();
market.provider.pollingInterval = 20;
const miner = setInterval(() => ex.mine(), 15); // startup deposits wait for their receipts
await market.init();
clearInterval(miner);

const counts = { capped: 0, noQuote: 0 };
const model = createModel();
const trader = new Trader(market, model, (e) => {
  if (e.quote?.capped) counts.capped++;
  if (e.decision && !e.decision.late && !e.quote) counts.noQuote++;
});
trader.attachTradeFeed(log10(market.params.sizePrecision));
const errors = new Map<string, number>();
console.error = (_: unknown, msg: unknown) => errors.set(String(msg), (errors.get(String(msg)) ?? 0) + 1);

const value = () => {
  const s = ex.status(), me = s.traders[market.address!.toLowerCase()]!;
  const ours = s.resting.filter((o) => o.owner === market.address!.toLowerCase());
  const lockedMon = ours.filter((o) => o.side === "sell").reduce((a, o) => a + o.size, 0);
  const lockedUsdc = ours.filter((o) => o.side === "buy").reduce((a, o) => a + o.size * o.price, 0);
  return { mid: ex.mid, mon: me.marginMon + lockedMon, usdc: me.marginUsdc + lockedUsdc };
};
const walletMon = async () => Number(ethers.utils.formatEther(await market.provider.getBalance(market.address!)));
const walletUsdc = async () => Number(ethers.utils.formatUnits(await new ethers.Contract(market.params.quoteAssetAddress, ["function balanceOf(address) view returns (uint256)"], market.provider).balanceOf(market.address!), 6));

const startMid = ex.mid, startValue = start.mon * startMid + start.usdc;
const t0 = performance.now();
for (let i = 0; i < blocks; i++) {
  ex.mine();
  await trader.onBlock(ex.block);
  await realSleep(4); // let this block's receipts and trade-log poll land
  if (process.env.PROGRESS && i % 2000 === 1999) log(`  ${i + 1} blocks, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
await realSleep(200);

const v = value(), wm = await walletMon(), wu = await walletUsdc();
const st = ex.stats(market.address!);
const endValue = (v.mon + wm) * v.mid + v.usdc + wu;
const hold = start.mon * v.mid + start.usdc;
const gasUsd = st.gasMon * v.mid;
const last = trader.history.at(-1)!;
const jevUsd = config.model === "jev" ? last.totals.jevUsd : 0; // the mock makes no paid inference calls
const result = {
  model: model.name, quoteEveryBlock: config.quoteEveryBlock, requoteTicks: config.requoteTicks,
  blocks, seed, size: config.tradeSizeMon, gasPerBlockMon: Number((st.gasMon / blocks).toFixed(5)),
  startUsd: +startValue.toFixed(3), endUsd: +endValue.toFixed(3), pnlUsd: +(endValue - startValue).toFixed(3), vsHoldUsd: +(endValue - hold).toFixed(3),
  gasUsd: +gasUsd.toFixed(3), tradingBeforeGasUsd: +(endValue - hold + gasUsd).toFixed(3),
  jevUsd, pnlAfterJevUsd: +(endValue - startValue - jevUsd).toFixed(3),
  sent: last.totals.quotes, kept: last.totals.kept, fills: st.fills, boughtMon: st.boughtMon, soldMon: st.soldMon, reverted: st.reverted, revertReasons: st.revertReasons,
  late: last.totals.lateBlocks, ...counts,
  walletMonLeft: +wm.toFixed(1), botPnlUsd: last.totals.pnlUsd, errors: Object.fromEntries(errors), seconds: Math.round((performance.now() - t0) / 1000),
};
log("RESULT " + JSON.stringify(result));
ex.stop();
process.exit(0);
