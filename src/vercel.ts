/** Request-driven Vercel container demo. The continuous worker entrypoint is index.ts. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Instances can scale independently or stop when idle. Never run a signing wallet in this mode.
process.env.DRY_RUN = "true";
process.env.PORT ??= "80";
// Vercel's application filesystem is not durable storage. Isolate each demo instance's logs.
process.chdir(mkdtempSync(join(tmpdir(), "jev-vercel-")));

// Config must be imported only after the environment and working directory have been set.
await import("./index");
