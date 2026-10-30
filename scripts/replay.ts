/** No wallet, signing, RPC or inference calls. */
import { createReadStream, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { replay, type ResearchFrame } from "../src/replay";
const file = process.argv[2];
if (!file || !process.env.SPLIT_BLOCK) throw new Error("Usage: SPLIT_BLOCK=<first test block> bun run scripts/replay.ts data/research.jsonl");
async function* frames() { for await (const line of createInterface({ input: createReadStream(file!), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line) as ResearchFrame; }
const options = { splitBlock: Number(process.env.SPLIT_BLOCK), startMon: Number(process.env.START_MON ?? 600), startUsdc: Number(process.env.START_USDC ?? 20), maxPosition: Number(process.env.MAX_POSITION_MON ?? 1000), size: Number(process.env.TRADE_SIZE_MON ?? 200), latencyBlocks: Number(process.env.LATENCY_BLOCKS ?? 2), requoteTicks: Number(process.env.REQUOTE_TICKS ?? 5) };
const result = await replay(frames(), options);
appendFileSync("replay-trials.jsonl", JSON.stringify({ timestamp: new Date().toISOString(), file, result }) + "\n");
console.log(JSON.stringify(result, null, 2));
