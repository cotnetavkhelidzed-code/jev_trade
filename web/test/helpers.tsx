/**
 * Shared test helpers: a tiny React render harness (react-dom/client + act), realistic
 * BlockEvent fixtures (shape from ../README.md and src/lib/types.ts), and fakes for the two
 * browser APIs the dashboard depends on, EventSource and ResizeObserver.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BlockEvent, Decision, Fill, Meta, Position, Quote, Totals } from "../src/lib/types";

/** True only when bun test runs from web/ with the preload in web/bunfig.toml. */
export const WEB = Boolean((globalThis as { __JEV_WEB_TEST__?: boolean }).__JEV_WEB_TEST__);

/** The three characters the repo's CLAUDE.md forbids in rendered text. */
export const BANNED = /[·—–]/;

// ---------------------------------------------------------------------------------------------
// render harness

export interface Mounted {
  container: HTMLDivElement;
  rerender(ui: ReactElement): void;
  unmount(): void;
  html(): string;
  text(): string;
  $(selector: string): Element | null;
  $$(selector: string): Element[];
}

const live = new Set<Mounted>();

export function render(ui: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
  const m: Mounted = {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      if (!live.has(m)) return;
      live.delete(m);
      act(() => root.unmount());
      container.remove();
    },
    html: () => container.innerHTML,
    text: () => container.textContent ?? "",
    $: (s) => container.querySelector(s),
    $$: (s) => Array.from(container.querySelectorAll(s)),
  };
  live.add(m);
  return m;
}

/** Unmount everything a test left mounted. */
export function cleanup(): void {
  for (const m of [...live]) m.unmount();
}

/** Renders a hook inside a probe component; `current()` is the latest return value. */
export function renderHook<P, T>(hook: (props: P) => T, props: P) {
  const out: { value: T | undefined } = { value: undefined };
  function Probe({ p }: { p: P }) {
    out.value = hook(p);
    return null;
  }
  const m = render(<Probe p={props} />);
  return {
    current: () => out.value as T,
    rerender: (p: P) => m.rerender(<Probe p={p} />),
    unmount: () => m.unmount(),
  };
}

/** Runs `fn` inside act(), e.g. to fire fake events or advance fake timers. */
export function run(fn: () => void): void {
  act(fn);
}

// ---------------------------------------------------------------------------------------------
// fixtures

export const WALLET = "0x7F3a1b2c3d4e5f60718293a4b5c6d7e8f9019C4e";
export const TX_QUOTE = "0x8f2c4e6a1b3d5f7091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7a8";
export const TX_FILL = "0x1d9e7c5a3b1f2e4d6c8b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5";
export const BASE_BLOCK = 105_488_269;
export const STARTED_AT = Date.UTC(2026, 9, 29, 12, 0, 0); // ms epoch, as the backend sends it

export function decision(action: "buy" | "sell", p = 0.77, latencyMs = 81): Decision {
  const q = Number((1 - p).toFixed(6));
  const buy = action === "buy" ? p : q;
  const sell = action === "buy" ? q : p;
  return { action, probabilities: { buy, sell, hold: 0 }, upIn10: buy, latencyMs, late: false };
}

/** What the backend emits when the previous block was still in flight. */
export function lateDecision(): Decision {
  return { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true };
}

export function quote(over: Partial<Quote> = {}): Quote {
  return {
    side: "buy",
    price: 0.022629,
    size: 200,
    txHash: TX_QUOTE,
    gasMon: 0.0357,
    cancel: [100295801],
    status: "placed",
    orderId: 100295812,
    capped: false,
    ...over,
  };
}

export function fill(over: Partial<Fill> = {}): Fill {
  return { side: "buy", size: 200, price: 0.022629, txHash: TX_FILL, orderId: 100295812, simulated: false, ...over };
}

export function position(over: Partial<Position> = {}): Position {
  return { side: "flat", size: 0, entryPrice: null, unrealizedUsd: 0, unrealizedMon: 0, ...over };
}

export function totals(over: Partial<Totals> = {}): Totals {
  return {
    blocks: 3,
    decisions: 3,
    quotes: 3,
    kept: 0,
    fills: 1,
    reverted: 0,
    lateBlocks: 0,
    jevUsd: 0.000004,
    gasMon: 0.107,
    gasUsd: 0.0024,
    realizedUsd: 0,
    pnlUsd: 0.003,
    pnlMon: 0.13,
    pnlPct: 0.003,
    ...over,
  };
}

/** A decided buy block like the README example; `block` defaults to an offset from BASE_BLOCK. */
export function ev(block: number = BASE_BLOCK, over: Partial<BlockEvent> = {}): BlockEvent {
  const mid = 0.022636 + ((block % 7) - 3) * 0.000004;
  return {
    block,
    ts: 1_789_593_630_676 + (block - BASE_BLOCK) * 300,
    mid,
    bestBid: mid - 0.000008,
    bestAsk: mid + 0.000008,
    spreadBps: 7.07,
    decision: decision("buy"),
    quote: quote(),
    fill: null,
    resting: { bidMon: 200, askMon: 200 },
    position: position(),
    totals: totals(),
    ...over,
  };
}

/** `count` consecutive decided blocks starting at `from`. */
export function blocks(count: number, from = BASE_BLOCK, over: (i: number) => Partial<BlockEvent> = () => ({})): BlockEvent[] {
  return Array.from({ length: count }, (_, i) => ev(from + i, over(i)));
}

export function meta(over: Partial<Meta> = {}): Meta {
  return { model: "jev-latest", wallet: WALLET, dryRun: false, market: "MON/USDC", startedAt: STARTED_AT, ...over };
}

// ---------------------------------------------------------------------------------------------
// EventSource fake

type Listener = (e: Event) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource was created");
    return es;
  }

  readonly url: string;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  // ---- driving helpers (each wraps the dispatch in act) ----

  open(): void {
    act(() => this.onopen?.(new Event("open")));
  }

  fail(): void {
    act(() => this.onerror?.(new Event("error")));
  }

  /** Fires a named SSE event; objects are JSON-encoded, strings are sent raw. */
  emit(type: string, data: unknown): void {
    const payload = typeof data === "string" ? data : data === undefined ? undefined : JSON.stringify(data);
    act(() => {
      for (const fn of this.listeners.get(type) ?? []) fn({ type, data: payload } as unknown as Event);
    });
  }

  snapshot(m: Partial<Meta> | null, history: BlockEvent[]): void {
    this.emit("snapshot", { ...(m ?? {}), history });
  }

  block(e: BlockEvent): void {
    this.emit("block", e);
  }
}

let savedEventSource: unknown;

export function installEventSource(): void {
  FakeEventSource.instances = [];
  savedEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
}

export function uninstallEventSource(): void {
  if (savedEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
  else (globalThis as { EventSource?: unknown }).EventSource = savedEventSource;
}

// ---------------------------------------------------------------------------------------------
// ResizeObserver fake

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly cb: ResizeObserverCallback;
  targets: Element[] = [];
  disconnected = false;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.targets.push(el);
  }

  unobserve(el: Element): void {
    this.targets = this.targets.filter((t) => t !== el);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets = [];
  }

  /** Reports a new content box for every observed element. */
  resize(width: number, height: number): void {
    const entries = this.targets.map(
      (target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry,
    );
    act(() => this.cb(entries, this as unknown as ResizeObserver));
  }

  /** Resizes every live observer (e.g. the chart's and the feed's). */
  static resizeAll(width: number, height: number): void {
    for (const ro of FakeResizeObserver.instances) if (!ro.disconnected) ro.resize(width, height);
  }
}

let savedResizeObserver: unknown;

export function installResizeObserver(): void {
  FakeResizeObserver.instances = [];
  savedResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
}

export function uninstallResizeObserver(): void {
  if (savedResizeObserver === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  else (globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver;
}

let originalClientHeight: PropertyDescriptor | undefined;

/**
 * Makes every element report `px` as its clientHeight (happy-dom has no layout, so it is 0).
 * `null` restores happy-dom's own getter.
 */
export function setClientHeight(px: number | null): void {
  originalClientHeight ??= Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  if (px === null) {
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    return;
  }
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => px });
}

// ---------------------------------------------------------------------------------------------
// app/layout.tsx needs next/font/google, which only works under the Next compiler.

export async function loadLayout() {
  const { mock } = await import("bun:test");
  mock.module("next/font/google", () => ({
    Inter: () => ({ className: "inter", variable: "inter-variable", style: { fontFamily: "Inter" } }),
    Geist_Mono: () => ({ className: "mono", variable: "mono-variable", style: { fontFamily: "Geist Mono" } }),
  }));
  return import("../src/app/layout");
}
