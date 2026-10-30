import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/practice-sim.ts");

async function run(model: "mock" | "jev", key = "") {
  const cwd = mkdtempSync(join(tmpdir(), "jev-sim-test-"));
  const calls = join(cwd, "calls.txt");
  const preload = join(cwd, "provider.ts");
  writeFileSync(preload, `
    import { writeFileSync } from "node:fs";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://api.typesafe.ai/v1/systemone") {
        if (new Headers(init.headers).get("authorization") !== "Bearer test-key") throw new Error("wrong key");
        writeFileSync(${JSON.stringify(calls)}, String(++calls));
        return Response.json({ model: "jev-latest", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.2 } } }, usage: { input_tokens: 1000, output_tokens: 0 } });
      }
      if (!url.startsWith("http://localhost:") && !url.startsWith("http://127.0.0.1:")) throw new Error("unexpected external request");
      return realFetch(input, init);
    });
  `);
  const proc = Bun.spawn([process.execPath, "--preload", preload, script], {
    cwd,
    env: { ...process.env, MODEL: model, TYPESAFE_AI_API_KEY: key, JEV_MODEL_ID: "jev-latest", BLOCKS: "8", SEED: "50", MOCK_LATENCY_MS: "20", QUOTE_EVERY_BLOCK: "false", REQUOTE_TICKS: "5", START_MON: "1350", START_USDC: "18", MARGIN_MON: "750", MARGIN_USDC: "18", PROGRESS: "", VERBOSE: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = stdout.split("\n").find((s) => s.startsWith("RESULT "));
  return { exitCode, stderr, result: line ? JSON.parse(line.slice(7)) : null, calls: await Bun.file(calls).exists() ? Number(await Bun.file(calls).text()) : 0 };
}

describe("practice simulator model selection", () => {
  test("MODEL=jev uses the Jev provider for each decision and reports inference costs", async () => {
    const r = await run("jev", "test-key");
    expect(r.exitCode).toBe(0);
    expect(r.calls).toBe(8);
    expect(r.result).toMatchObject({ model: "jev-latest", blocks: 8, quoteEveryBlock: false, jevUsd: 0.000336, errors: {} });
    expect(r.result.kept).toBeGreaterThan(0);
    expect(r.result.sent + r.result.kept).toBe(8);
  }, 20_000);

  test("MODEL=mock stays local and honors order retention", async () => {
    const r = await run("mock");
    expect(r.exitCode).toBe(0);
    expect(r.calls).toBe(0);
    expect(r.result).toMatchObject({ model: "mock", blocks: 8, quoteEveryBlock: false, jevUsd: 0, errors: {} });
    expect(r.result.pnlAfterJevUsd).toBe(r.result.pnlUsd);
    expect(r.result.kept).toBeGreaterThan(0);
    expect(r.result.sent + r.result.kept).toBe(8);
  }, 20_000);

  test("MODEL=jev without a key fails instead of reporting a mock run as Jev", async () => {
    const r = await run("jev");
    expect(r.exitCode).not.toBe(0);
    expect(r.result).toBeNull();
    expect(r.stderr).toContain("MODEL=jev requires TYPESAFE_AI_API_KEY");
    expect(r.calls).toBe(0);
  });
});
