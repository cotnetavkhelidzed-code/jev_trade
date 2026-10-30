import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import { startPracticeExchange } from "../scripts/practice-exchange";
import { until } from "./helpers";

test("Vercel container entrypoint always simulates, even when a signing key and live flag are present", async () => {
  const exchange = startPracticeExchange({ blockMs: 300, seed: 71 });
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/vercel.ts")], {
    cwd: mkdtempSync(join(tmpdir(), "jev-vercel-test-")),
    env: { ...process.env, DRY_RUN: "false", PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
      MODEL: "mock", RPC_URL: exchange.url, READ_RPC_URL: exchange.url, WS_URL: exchange.wsUrl, PORT: String(port) },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    let ready = false;
    const base = `http://localhost:${port}`;
    await until(() => {
      if (!ready) fetch(base).then(r => r.json()).then(snapshot => { ready = snapshot.dryRun && snapshot.wallet === null; }).catch(() => {});
      return ready;
    }, 5000, "dry-run container startup");
    let history: any[] = [];
    await until(() => {
      fetch(`${base}/history`).then(r => r.json()).then(rows => { history = rows; }).catch(() => {});
      return history.length >= 3;
    }, 5000, "container block history");
    expect(history.every(row => !row.quote || row.quote.txHash === null)).toBe(true);
    expect(exchange.requests.get("eth_sendRawTransaction") ?? 0).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    exchange.stop();
  }
}, 15_000);
