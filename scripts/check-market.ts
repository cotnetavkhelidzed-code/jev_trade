/** Read-only book diagnostics. Writes raw, block-pinned observations; never signs or trades.
 * The Spot V2 comparison is diagnostic only, not an adapter for the legacy trading loop.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { decodeL2Book, decodeVaultParams, formatLevels, log10, SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS } from "../src/book";

// https://docs.kuru.io/deployments/mainnet and /contracts/orderbook
const currentMarket = "0xc9dE998e272d59a19CEA3783C8dd44f87A86405D";
const currentAbi = new ethers.utils.Interface([
  "function getL2Book(uint256) view returns (uint32[] bidPrices,uint96[] bidSizes,uint32[] askPrices,uint96[] askSizes)",
  "function getMarketParams() view returns (uint32,uint96,uint32,uint96,uint96,uint256,uint256)",
]);
const samples = Number(process.env.SAMPLES ?? 5);
if (!Number.isInteger(samples) || samples < 1 || samples > 1000) throw new Error("SAMPLES must be 1..1000");
const directory = `data/market-check-${Date.now()}`;
mkdirSync(directory, { recursive: true });
const provider = new ethers.providers.StaticJsonRpcProvider(config.readRpcUrl, config.chainId);
const params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
const call = (to: string, data: string, tag: string) => rpc<string>("eth_call", [{ to, data }, tag], config.readRpcUrl);
const observations: { block: number; legacyBidLevels: number; legacyAskLevels: number; currentBidLevels: number | null; currentAskLevels: number | null }[] = [];
for (let i = 0; i < samples; i++) {
  const tag = await rpc<string>("eth_blockNumber", [], config.readRpcUrl);
  const [legacyBook, legacyVault, currentBook, currentParams] = await Promise.all([
    call(config.market, SEL_GET_L2_BOOK, tag), call(config.market, SEL_GET_VAULT_PARAMS, tag),
    call(currentMarket, currentAbi.encodeFunctionData("getL2Book", [5]), tag).catch(() => null),
    call(currentMarket, currentAbi.encodeFunctionData("getMarketParams"), tag).catch(() => null),
  ]);
  const legacy = formatLevels(decodeL2Book(legacyBook, log10(params.pricePrecision), log10(params.sizePrecision)), params, decodeVaultParams(legacyVault));
  const current = currentBook ? currentAbi.decodeFunctionResult("getL2Book", currentBook) : null;
  const observation = { block: parseInt(tag, 16), legacyBidLevels: legacy.bids.length, legacyAskLevels: legacy.asks.length,
    currentBidLevels: current ? current.bidPrices.length : null, currentAskLevels: current ? current.askPrices.length : null };
  observations.push(observation);
  appendFileSync(`${directory}/observations.jsonl`, JSON.stringify({ timestamp: new Date().toISOString(), ...observation,
    legacyMarket: config.market, currentMarket, raw: { legacyBook, legacyVault, currentBook, currentParams } }) + "\n");
  if (i + 1 < samples) await Bun.sleep(1000);
}
const summary = { source: "read-only Monad mainnet", legacyMarket: config.market, currentMarket, samples,
  validLegacyBooks: observations.filter(o => o.legacyBidLevels > 0 && o.legacyAskLevels > 0).length,
  currentTwoSidedBooks: observations.filter(o => (o.currentBidLevels ?? 0) > 0 && (o.currentAskLevels ?? 0) > 0).length,
  observations, directory, replayCompatible: false,
  note: "Raw diagnostics only. Spot V2 requires a separate execution and event integration; no profitability result can be inferred." };
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
