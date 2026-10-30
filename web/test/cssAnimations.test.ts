/**
 * The repo's CLAUDE.md forbids blinking or pulsing indicators: a CSS animation that loops
 * (infinite, or more than one iteration) and animates opacity, visibility or scale.
 * Scan every stylesheet under web/src (and inline styles / SVG <animate> in the components).
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import { WEB } from "./helpers";

const SRC = path.resolve(import.meta.dir, "../src");

interface Block {
  prelude: string;
  /** declarations directly in this block (nested blocks removed) */
  decls: string;
  children: Block[];
}

/** A small brace-matching CSS parser: enough for rules, @media and @keyframes. */
function parseCss(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  function parseBlocks(): { blocks: Block[]; decls: string } {
    const blocks: Block[] = [];
    let decls = "";
    let buf = "";
    while (i < src.length) {
      const ch = src[i++];
      if (ch === "{") {
        // the prelude is whatever followed the last declaration terminator
        const cut = Math.max(buf.lastIndexOf(";"), buf.lastIndexOf("}"));
        decls += buf.slice(0, cut + 1);
        const prelude = buf.slice(cut + 1).trim();
        buf = "";
        const inner = parseBlocks();
        blocks.push({ prelude, decls: inner.decls, children: inner.blocks });
      } else if (ch === "}") {
        return { blocks, decls: decls + buf };
      } else {
        buf += ch;
      }
    }
    return { blocks, decls: decls + buf };
  }
  return parseBlocks().blocks;
}

function declarations(text: string): [string, string][] {
  return text
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()];
    });
}

function walk(blocks: Block[], ctx: string[], fn: (b: Block, ctx: string[]) => void) {
  for (const b of blocks) {
    fn(b, ctx);
    walk(b.children, [...ctx, b.prelude], fn);
  }
}

const BLINKY = /^(opacity|visibility|scale)$/;

/** Properties a keyframes block animates, with transform scale reported as "scale". */
function animatedProps(kf: Block): Set<string> {
  const props = new Set<string>();
  for (const step of kf.children)
    for (const [p, v] of declarations(step.decls)) {
      if (p === "transform" && /scale/i.test(v)) props.add("scale");
      else props.add(p);
    }
  return props;
}

interface Anim {
  file: string;
  selector: string;
  name: string;
  iterations: string;
}

function animationsOf(file: string, blocks: Block[], keyframes: Set<string>): Anim[] {
  const out: Anim[] = [];
  walk(blocks, [], (b, ctx) => {
    if (b.prelude.startsWith("@")) return;
    if (ctx.some((c) => c.startsWith("@keyframes"))) return;
    const ds = declarations(b.decls);
    const count = ds.find(([p]) => p === "animation-iteration-count")?.[1];
    const names = ds.find(([p]) => p === "animation-name")?.[1];
    for (const [p, v] of ds) {
      if (p !== "animation") continue;
      for (const one of v.split(",")) {
        const tokens = one.trim().split(/\s+/);
        const name = tokens.find((t) => keyframes.has(t)) ?? names ?? "";
        // a bare number (no unit) is the iteration count; time values carry s/ms
        const iter = count ?? tokens.find((t) => t === "infinite" || /^\d+(\.\d+)?$/.test(t)) ?? "1";
        out.push({ file, selector: [...ctx, b.prelude].join(" > "), name, iterations: iter });
      }
    }
    if (!ds.some(([p]) => p === "animation") && names && count)
      out.push({ file, selector: [...ctx, b.prelude].join(" > "), name: names, iterations: count });
  });
  return out;
}

const loops = (iter: string) => iter === "infinite" || Number(iter) > 1;

async function scan() {
  const files: { rel: string; blocks: Block[] }[] = [];
  for await (const rel of new Glob("**/*.css").scan(SRC)) {
    files.push({ rel, blocks: parseCss(await Bun.file(path.join(SRC, rel)).text()) });
  }
  // keyframes are global in practice (CSS modules scope them per file, but check them all)
  const keyframes = new Map<string, Set<string>>();
  for (const f of files)
    walk(f.blocks, [], (b) => {
      const m = /^@(?:-webkit-)?keyframes\s+(\S+)/.exec(b.prelude);
      if (m) keyframes.set(m[1], animatedProps(b));
    });
  const anims = files.flatMap((f) => animationsOf(f.rel, f.blocks, new Set(keyframes.keys())));
  return { files, keyframes, anims };
}

describe.skipIf(!WEB)("no blinking or pulsing indicators", () => {
  test("the scanner finds the stylesheets, keyframes and animations it should", async () => {
    const { files, keyframes, anims } = await scan();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(keyframes.size).toBeGreaterThan(0);
    // the one-shot cues are seen and classified as non-looping
    const ripple = anims.find((a) => a.name === "ripple");
    expect(ripple?.iterations).toBe("1");
    // a synthetic pulse is caught
    const blocks = parseCss(`@keyframes p { 50% { opacity: .2 } } .dot { animation: p 1s ease-in-out infinite; }`);
    const fake = animationsOf("x.css", blocks, new Set(["p"]));
    expect(fake).toEqual([{ file: "x.css", selector: ".dot", name: "p", iterations: "infinite" }]);
  });

  test("no CSS animation loops opacity, visibility or scale", async () => {
    const { keyframes, anims } = await scan();
    const offenders = anims
      .filter((a) => loops(a.iterations))
      .map((a) => ({ ...a, animates: [...(keyframes.get(a.name) ?? new Set(["<unknown keyframes>"]))] }))
      .filter((a) => a.animates.some((p) => BLINKY.test(p) || p === "<unknown keyframes>"))
      .map((a) => `${a.file}: ${a.selector} { animation: ${a.name} ... ${a.iterations} } animates ${a.animates.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  test("no inline animations or SMIL <animate> loops in the components", async () => {
    const hits: string[] = [];
    for await (const rel of new Glob("**/*.tsx").scan(SRC)) {
      const text = await Bun.file(path.join(SRC, rel)).text();
      for (const re of [/animation(IterationCount|Name)?\s*:/, /<animate(Transform|Motion)?\b/, /repeatCount/, /text-decoration\s*:\s*blink/]) {
        if (re.test(text)) hits.push(`${rel}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
