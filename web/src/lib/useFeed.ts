"use client";

import { useEffect, useReducer } from "react";
import type { BlockEvent, ConnectionState, FeedState, Fill, Meta, Quote } from "./types";

export { useUptime } from "./useUptime";

/** Max block events kept in memory (oldest -> newest). */
const CAP = 1000;
/** Reconnect backoff, doubling from 1s up to 10s. */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
/** If nothing arrives for this long (server pings every few seconds), force a reconnect. */
const STALE_MS = 45_000;
/** Fills/quotes for blocks not received yet are held for at most this many blocks. */
const EARLY_MAX = 50;

interface State extends FeedState {
  /** running accumulators so avgLatencyMs stays O(1) per event */
  latSum: number;
  latCount: number;
  /** A fill or quote can overtake its own block on the wire: held here until that block arrives. */
  early: { fills: Record<number, Fill>; quotes: Record<number, Quote> };
}

type Action =
  | { type: "snapshot"; meta: Meta | null; history: BlockEvent[] }
  | { type: "block"; event: BlockEvent }
  | { type: "fill"; block: number; fill: Fill }
  | { type: "quote"; block: number; quote: Quote }
  | { type: "connection"; connection: ConnectionState };

const initialState: State = {
  meta: null,
  events: [],
  latest: null,
  connection: "connecting",
  avgLatencyMs: 0,
  latSum: 0,
  latCount: 0,
  early: { fills: {}, quotes: {} },
};

const NO_EARLY: State["early"] = { fills: {}, quotes: {} };

/** Keep `item` for `block` until the block arrives (only for blocks newer than any we have). */
function hold<T>(bucket: Record<number, T>, block: number, item: T): Record<number, T> {
  const next = { ...bucket, [block]: item };
  const keys = Object.keys(next).map(Number).sort((a, b) => a - b);
  for (const k of keys.slice(0, Math.max(0, keys.length - EARLY_MAX))) delete next[k];
  return next;
}

/** Attach what was held for `ev.block` and drop anything held for older blocks (they will not come). */
function release(early: State["early"], ev: BlockEvent): { ev: BlockEvent; early: State["early"] } {
  const fill = early.fills[ev.block], quote = early.quotes[ev.block];
  const keep = <T>(b: Record<number, T>) => Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) > ev.block)) as Record<number, T>;
  return {
    ev: fill || quote ? { ...ev, ...(fill ? { fill } : {}), ...(quote ? { quote } : {}) } : ev,
    early: Object.keys(early.fills).length || Object.keys(early.quotes).length ? { fills: keep(early.fills), quotes: keep(early.quotes) } : early,
  };
}

/** latencyMs of a decided (non-late) block, or null if it should not count. */
function latencyOf(e: BlockEvent): number | null {
  const d = e?.decision;
  if (!d || d.late || typeof d.latencyMs !== "number" || !Number.isFinite(d.latencyMs)) return null;
  return d.latencyMs;
}

function indexOfBlock(events: BlockEvent[], block: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].block === block) return i;
  return -1;
}

function avg(latSum: number, latCount: number): number {
  return latCount > 0 ? Math.round(latSum / latCount) : 0;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };

    case "snapshot": {
      const history = Array.isArray(action.history) ? action.history : [];
      const events = history.length > CAP ? history.slice(history.length - CAP) : history;
      let latSum = 0;
      let latCount = 0;
      for (const e of events) {
        const l = latencyOf(e);
        if (l !== null) {
          latSum += l;
          latCount++;
        }
      }
      return {
        meta: action.meta ?? state.meta,
        events,
        latest: events.length ? events[events.length - 1] : null,
        connection: "live",
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
        early: NO_EARLY,
      };
    }

    case "block": {
      if (!action.event || typeof action.event.block !== "number") return state;
      const { ev, early } = release(state.early, action.event);
      const prev = state.events;
      const last = prev.length ? prev[prev.length - 1] : null;

      // Dedupe: a re-sent block replaces the one we already have; a stale older block is dropped.
      if (last && ev.block <= last.block) {
        const idx = indexOfBlock(prev, ev.block);
        if (idx < 0) return state;
        const events = prev.slice();
        const old = events[idx];
        events[idx] = ev;
        let latSum = state.latSum;
        let latCount = state.latCount;
        const o = latencyOf(old);
        if (o !== null) {
          latSum -= o;
          latCount--;
        }
        const n = latencyOf(ev);
        if (n !== null) {
          latSum += n;
          latCount++;
        }
        return {
          ...state,
          events,
          latest: events[events.length - 1],
          avgLatencyMs: avg(latSum, latCount),
          latSum,
          latCount,
          early,
        };
      }

      let latSum = state.latSum;
      let latCount = state.latCount;
      const n = latencyOf(ev);
      if (n !== null) {
        latSum += n;
        latCount++;
      }
      let events = prev.concat(ev);
      if (events.length > CAP) {
        const drop = events.length - CAP;
        for (let i = 0; i < drop; i++) {
          const l = latencyOf(events[i]);
          if (l !== null) {
            latSum -= l;
            latCount--;
          }
        }
        events = events.slice(drop); // only ever slices once we are over the cap
      }
      return {
        ...state,
        events,
        latest: ev,
        avgLatencyMs: avg(latSum, latCount),
        latSum,
        latCount,
        early,
      };
    }

    case "fill": {
      const idx = indexOfBlock(state.events, action.block);
      if (idx < 0) {
        const newest = state.events.length ? state.events[state.events.length - 1].block : -Infinity;
        if (action.block <= newest) return state; // an old block we no longer keep
        return { ...state, early: { ...state.early, fills: hold(state.early.fills, action.block, action.fill) } };
      }
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], fill: action.fill };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    case "quote": {
      const idx = indexOfBlock(state.events, action.block);
      if (idx < 0) {
        const newest = state.events.length ? state.events[state.events.length - 1].block : -Infinity;
        if (action.block <= newest) return state;
        return { ...state, early: { ...state.early, quotes: hold(state.early.quotes, action.block, action.quote) } };
      }
      const events = state.events.slice();
      const updated: BlockEvent = { ...events[idx], quote: action.quote };
      events[idx] = updated;
      return {
        ...state,
        events,
        latest: idx === events.length - 1 ? updated : state.latest,
      };
    }

    default:
      return state;
  }
}

function parseMeta(raw: Record<string, unknown> | null): Meta | null {
  if (!raw) return null;
  return {
    model: typeof raw.model === "string" ? raw.model : "",
    wallet: typeof raw.wallet === "string" ? raw.wallet : null,
    dryRun: Boolean(raw.dryRun),
    market: typeof raw.market === "string" ? raw.market : "MON/USDC",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
  };
}

/**
 * Live block feed over SSE.
 *
 * Connects to `${apiUrl}/events` and handles: `snapshot` (meta + history),
 * `block` (append, deduped by block number, capped at 1000), `quote`
 * ({ block, quote } -> replaces that block's quote once its receipt lands), `fill`
 * ({ block, fill } -> a taker hit our resting order in that block) and `ping` (liveness).
 * Reconnects with 1s -> 10s backoff, surfacing `connection`.
 */
export function useFeed(apiUrl: string): FeedState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const base = (apiUrl || "").replace(/\/+$/, "");

    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };

    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStaleTimer();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          return;
        }
        fn(data);
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${base}/events`);
      armStaleTimer(); // a connection that never opens (and never errors) must still be retried

      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStaleTimer();
      };
      es.onerror = () => {
        if (!closed) scheduleReconnect();
      };

      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        const history = Array.isArray(d.history) ? (d.history as BlockEvent[]) : [];
        dispatch({ type: "snapshot", meta: parseMeta(d), history });
      });
      handle("block", (data) => {
        dispatch({ type: "block", event: data as BlockEvent });
      });
      handle("fill", (data) => {
        const d = (data ?? {}) as { block?: number; fill?: Fill };
        if (typeof d.block !== "number" || !d.fill) return;
        dispatch({ type: "fill", block: d.block, fill: d.fill });
      });
      handle("quote", (data) => {
        const d = (data ?? {}) as { block?: number; quote?: Quote };
        if (typeof d.block !== "number" || !d.quote) return;
        dispatch({ type: "quote", block: d.block, quote: d.quote });
      });
      handle("ping", () => {
        dispatch({ type: "connection", connection: "live" });
      });
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [apiUrl]);

  return state;
}

export default useFeed;
