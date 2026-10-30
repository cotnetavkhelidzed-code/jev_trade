# Jev Trader — web

Next.js (App Router, TypeScript, CSS Modules — no Tailwind) frontend for Jev Trader:
one AI trade decision every Monad block.

## Run

```bash
export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
bun install
bun run dev      # http://localhost:3000
bun run build
```

Use Bun only — npm is broken on this machine.

## Config

With Vercel Services, run `vercel dev` from the repository root (or `vercel dev -L`
without cloud authentication). The browser opens `/api/trader/events` on the same
origin. The Next.js route handler reads the runtime-only `JEV_APP_URL` binding to
reach the internal `app` service and forwards snapshots, history and SSE without
buffering. Vercel injects this variable; do not set it or expose it with a
`NEXT_PUBLIC_` prefix. The binding is never read during the build or in middleware.

For a standalone dashboard, `NEXT_PUBLIC_API_URL` can explicitly override the
browser's API base URL. Copy `.env.example` to `.env.local` and set that override
only when using a separately hosted backend. Remove an existing Railway override
when switching to the single-project Vercel setup.

## Layout

- `src/lib/types.ts` — wire types (`BlockEvent`, `Decision`, `Fill`, `Meta`, …)
- `src/lib/useFeed.ts` — SSE hook: snapshot / block / fill / ping, 1000-event
  window, 1s→10s reconnect backoff, `connection` state, `avgLatencyMs`
- `src/lib/useUptime.ts` — `useUptime(startedAt)` → ticking `"hh:mm:ss"`
- `src/lib/format.ts` — number/address/tx formatting
- `src/app/globals.css` — design tokens, `pulse`/`breathe` keyframes, `.card`
- `src/components/<Name>/<Name>.tsx` — UI components (one folder each)
