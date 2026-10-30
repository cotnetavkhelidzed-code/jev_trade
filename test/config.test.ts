import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "../src/config";

const CONFIG = resolve(import.meta.dir, "../src/config.ts");
const KEYS = ["MAKER_FEE_BPS", "STRATEGY_ENABLED", "STRATEGY_MIN_SAMPLES", "STRATEGY_MIN_FILLS", "MIN_EDGE_USD", "EDGE_UNCERTAINTY", "EXIT_COST_BPS", "MAX_LOSS_USD", "MAX_VOL_BPS", "RECORD_RESEARCH", "QUOTE_EVERY_BLOCK", "REQUOTE_TICKS", "GAS_HEADROOM", "GAS_PER_CANCEL", "RPC_URL", "READ_RPC_URL", "WS_URL", "MARKET", "MARGIN_ACCOUNT", "PRIVATE_KEY", "DRY_RUN", "TRADE_SIZE_MON", "MAX_POSITION_MON", "BANKROLL_USD", "QUOTE_INSIDE_TICKS", "MARGIN_MON", "MARGIN_USDC", "GAS_LIMIT", "MAX_FEE_GWEI", "PRIORITY_FEE_GWEI", "HORIZON_BLOCKS", "MODEL", "JEV_MODEL_ID", "PORT"];

/** Load src/config.ts in a fresh process with exactly `env` set (and no .env file in reach). */
function load(env: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !KEYS.includes(k)) clean[k] = v;
  const cwd = mkdtempSync(join(tmpdir(), "jev-config-"));
  const r = Bun.spawnSync([process.execPath, "-e", `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify(config, (k, v) => v === undefined ? "__undefined__" : v));`], { cwd, env: { ...clean, ...env } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

describe("config", () => {
  test("defaults match .env.example and the README", () => {
    const c = load({});
    expect(c).toEqual({
      makerFeeBpsOverride: "__undefined__", strategyEnabled: true, strategyMinSamples: 30, strategyMinFills: 10,
      minEdgeUsd: .001, edgeUncertainty: 2, exitCostBps: 10, maxLossUsd: 5, maxVolBps: 30, recordResearch: true,
      rpcUrl: "https://rpc.monad.xyz",
      readRpcUrl: "https://rpc.monad.xyz",
      wsUrl: "__undefined__",
      chainId: 143,
      market: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
      marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
      privateKey: "__undefined__",
      dryRun: true,
      tradeSizeMon: 200,
      maxPositionMon: 1000,
      bankrollUsd: 100,
      quoteInsideTicks: 1,
      quoteEveryBlock: false,
      requoteTicks: 5,
      marginMon: 600,
      marginUsdc: 20,
      gasLimit: "__undefined__",
      gasLimitFallback: 350_000,
      gasHeadroom: 0.1,
      gasPerCancel: 25_000,
      maxFeeGwei: 400,
      priorityFeeGwei: 2,
      pendingBlocks: 10,
      refreshBlocks: 200,
      horizonBlocks: 100,
      model: "mock",
      jevModelId: "jev-latest",
      jevUsdPerMTok: 0.042,
      port: 3000,
      historySize: 1000,
    });
  });

  test("a private key turns the dry run off", () => {
    expect(load({ PRIVATE_KEY: "0xabc" }).dryRun).toBe(false);
  });

  test("DRY_RUN=true wins over a private key", () => {
    expect(load({ PRIVATE_KEY: "0xabc", DRY_RUN: "true" }).dryRun).toBe(true);
  });

  test("an empty PRIVATE_KEY (as copied from .env.example) is still a dry run", () => {
    expect(load({ PRIVATE_KEY: "", DRY_RUN: "false" }).dryRun).toBe(true);
  });

  test("DRY_RUN must be exactly 'true' to force a dry run", () => {
    expect(load({ PRIVATE_KEY: "0xabc", DRY_RUN: "1" }).dryRun).toBe(false);
  });

  test("an empty GAS_LIMIT means estimate at startup; a number overrides", () => {
    expect(load({ GAS_LIMIT: "" }).gasLimit).toBe("__undefined__");
    expect(load({ GAS_LIMIT: "400000" }).gasLimit).toBe(400000);
  });

  test("every numeric and string setting reads its env var", () => {
    const c = load({
      RPC_URL: "http://send", READ_RPC_URL: "http://read", WS_URL: "ws://ws", MARKET: "0xm", MARGIN_ACCOUNT: "0xma",
      TRADE_SIZE_MON: "250", MAX_POSITION_MON: "800", BANKROLL_USD: "50", QUOTE_INSIDE_TICKS: "0", QUOTE_EVERY_BLOCK: "true", REQUOTE_TICKS: "3", MARGIN_MON: "700",
      MARGIN_USDC: "30", GAS_HEADROOM: "0.2", GAS_PER_CANCEL: "18000", MAX_FEE_GWEI: "300", PRIORITY_FEE_GWEI: "3", HORIZON_BLOCKS: "20", MODEL: "jev", JEV_MODEL_ID: "jev-x", PORT: "8080",
    });
    expect(c).toMatchObject({
      rpcUrl: "http://send", readRpcUrl: "http://read", wsUrl: "ws://ws", market: "0xm", marginAccount: "0xma",
      tradeSizeMon: 250, maxPositionMon: 800, bankrollUsd: 50, quoteInsideTicks: 0, quoteEveryBlock: true, requoteTicks: 3, marginMon: 700, marginUsdc: 30,
      gasHeadroom: 0.2, gasPerCancel: 18_000, maxFeeGwei: 300, priorityFeeGwei: 3, horizonBlocks: 20, model: "jev", jevModelId: "jev-x", port: 8080,
    });
  });

  test("the in-process config is the same object every module sees", async () => {
    const again = (await import("../src/config")).config;
    expect(again).toBe(config);
  });
});
