# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. A post-only limit order rests on that side, one tick inside the touch. While its side, remaining size and price still fit, it stays on the book without another transaction or gas charge. Otherwise it is cancelled and replaced. Fills happen when a taker hits it, so the bot earns the spread instead of paying it. A small server streams every block to the dashboard.

## Current integration status

This code targets **legacy Kuru V1**. On 2026-10-30 the configured MON-USDC book had no bids,
so the dry-run loop could not produce valid market snapshots or a performance recording.
Kuru's [current mainnet deployment](https://docs.kuru.io/deployments/mainnet) uses Spot V2:
its MON-USDC market, AccountCore custody, order entrypoints, packed events, fee rules and
minimum order notional differ. Switching `MARKET` alone is insufficient. A V2 adapter and
restart recovery are still required before unattended live use.

`bun run verify:jev` sends one real Jev request on a fixed synthetic snapshot and prints safe
connection diagnostics. It never trades and does not measure predictive quality or profitability.
`bun run check:market` saves five raw, block-pinned V1/V2 liquidity observations under a fresh
`data/market-check-*` directory. These diagnostic files are separate from replay research frames.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

`QUOTE_EVERY_BLOCK=false` (default) keeps a full-size order on the chosen side when it is within `REQUOTE_TICKS` (default 5) of a fresh quote and does not cross the other side. Side changes, partial fills and larger price moves trigger a replacement. Set `QUOTE_EVERY_BLOCK=true` to restore a new order every block. The model still decides every block in both modes.

## Test and practice

Use Bun 1.3.14. CI runs the backend type check, both test suites and the dashboard production build.

    bun test --coverage              # backend: unit tests plus end to end runs against the practice exchange
    cd web && bun test --coverage    # dashboard

`scripts/practice-exchange.ts` is a local stand-in for Monad and Kuru's MON-USDC book: a random-walk market with takers that executes the bot's real signed `batchUpdate`s (cancels first, then post-only places, against the margin account) and serves the same JSON-RPC and WebSocket heads. Paper trade the full live path with a throwaway key, no real funds:

    bun run scripts/practice-exchange.ts 8545
    RPC_URL=http://localhost:8545 READ_RPC_URL=http://localhost:8545 WS_URL=ws://localhost:8545 PRIVATE_KEY=<throwaway key> bun run start

To measure a setting without waiting an hour, `scripts/practice-sim.ts` runs the same bot code block after block as fast as it goes and prints what the account is worth against its start and against holding. 12,000 blocks represent one hour at 300 ms per block; elapsed time depends on model latency:

    BLOCKS=12000 SEED=50 START_MON=1350 START_USDC=18 MARGIN_MON=750 MARGIN_USDC=18 bun run scripts/practice-sim.ts

The simulator honors `MODEL` and the quote settings from the environment or `.env`. For real Jev calls, set `MODEL=jev` and `TYPESAFE_AI_API_KEY`; a missing key stops the run instead of substituting the mock. The result names the model and reports sent/kept counts, gas and Jev costs, and P&L after inference costs. Orders use a generated practice wallet on the local exchange. This is a synthetic market test, not a measure of live profitability or a test of keeping up with real block timing.

## Endpoints

Deployed (dry run, mock model): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, a `quote` event when a live order's receipt lands, a `fill` event when a taker hits a resting order (always after its block's `block` event), and a `ping` every 15 s

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "kept": 0, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order selected for that block. A new order is a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels eligible resting orders (`cancel`). A kept order has `status: "resting"`, zero gas and the transaction hash of its original placement; `totals.kept` counts these blocks and `totals.quotes` counts new orders. `hold` appears only with `decision.late: true`, when the model missed the block and nothing was posted. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true` and `probabilities` still show the model's call. Margin is booked the way Kuru moves it (a place locks funds, a cancel gives back what is left, a fill credits the other asset) and re-read from the chain every 200 blocks and after any revert, so an order the margin cannot fund is never sent. `MARGIN_MON` and `MARGIN_USDC` bound how far each way the position can go; the bot warns at startup when that is less than `MAX_POSITION_MON`. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). After a revert the bot checks the orders it tried to cancel with `s_orders` and drops any that are gone. Each update cancels only what no unconfirmed update ahead of it is already cancelling (Kuru reverts a cancel of an order that is gone), and a fill that arrives before its order's receipt is remembered, so a filled order never comes back as resting. No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. That poll usually returns while the model is still deciding the same block, so the fill rides on that block's event (`fill`) and a `fill` event follows it; a fill read later gets its own `fill` event for its block. `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run a new quote is `status: "sim"`: the order rests from the next block until replaced or filled, and a real print crossing its price fills it (`simulated: true`). Kept simulated quotes use `status: "resting"` with no transaction hash.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded batchUpdate (cancel + post-only place), margin deposits and ledger, local nonce, async confirmation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trades.ts   Trade log feed (eth_getLogs): taker prints, our maker fills, CVD summary
    src/trader.ts   the loop: one in flight, hold when late, which orders to cancel, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

## The 300 ms budget

A decision and any replacement order have to fit in one block, so the hot loop makes one
`eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and, only when placing an order,
one `eth_sendRawTransaction` (`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so one place is estimated once at startup and each
tx's limit is that plus `GAS_HEADROOM`, plus `GAS_PER_CANCEL` per cancel it carries), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK

## Trading rulebook and profit-aware execution

The execution policy now defaults to `STRATEGY_ENABLED=true`. This supersedes the original
"always quote" demo behavior above. Jev still forecasts buy or sell every block; the execution
policy can skip, keep, place, or cancel. A deliberate skip is shown as SKIP, not LATE.
`STRATEGY_ENABLED=false` explicitly restores the original demo execution for comparison.

`src/rulebook.ts` contains an original, compact rulebook inspired by *Algorithmic and
High-Frequency Trading*, Álvaro Cartea, Sebastian Jaimungal and José Penalva (Cambridge, 2015),
particularly chapters 10 (market making) and 12 (order imbalance).
[Author's book page, sample code and errata](https://sebastian.statistics.utoronto.ca/books/algo-and-hf-trading/).
This is an implementation of selected principles, not the full ebook or a claim to implement
all textbook models. The rules are sent to Jev with each forecast; arithmetic and risk limits
run locally. The rulebook version and gate reason are recorded on every evaluated block.

The six changes are:

1. **Net edge gate.** Shadow orders collect evidence without spending funds. Each bucket uses
   side, Jev confidence band, distance from mid in bps, and volatility band. One shadow order
   per bucket expires after `HORIZON_BLOCKS`; its marked result matures after twice that horizon.
   Outcomes include zero and partial fills, maker fees/rebates, and an eventual exit allowance.
   Only past matured outcomes enter the estimate. Orders require `STRATEGY_MIN_SAMPLES` attempts,
   `STRATEGY_MIN_FILLS` filled attempts, and a lower estimate exceeding `MIN_EDGE_USD` after gas
   and inference. The uncertainty deduction is a sample standard-error multiplier, not a
   statistically guaranteed confidence bound. Warmup can take a long time or never pass.
2. **Portfolio context.** Jev sees session inventory, cost basis, resting/pending exposure,
   free margin, costs, volatility, and quote age. A blocked buy is skipped rather than reversed
   into a sell. Inventory/funding constraints count unconfirmed orders too.
3. **Fill evaluation.** `data/markouts.jsonl` measures actual fills after 4, 34, and 100 blocks
   (about 1, 10, and 30 seconds). Missing blocks use the next observed mid and retain its block
   number. `data/calibration.jsonl` records non-overlapping forecast outcomes and Brier scores.
4. **Adaptive quotes.** Volatility and inventory move quotes farther from the touch and reduce
   size down to the chain minimum. If even the minimum violates the budget, skip. Economically
   acceptable orders retain priority within `REQUOTE_TICKS`; they expire after the quote horizon.
   Failed gates cancel confirmed resting orders using a cancel-only batch. Unconfirmed orders
   can only be cancelled once their receipts supply an ID. `QUOTE_EVERY_BLOCK` applies to legacy
   mode; the strategy preserves suitable orders regardless of that switch.
5. **Net accounting.** Session P&L subtracts gas, inference and signed maker fees (negative means
   rebate); mock inference costs zero. For this legacy Kuru contract, positive on-chain
   `makerFeeBps` means a rebate, so it is normalized to a negative cost. `MAKER_FEE_BPS` can
   override the signed accounting assumption; it does not alter exchange charges. The exit
   allowance is an estimate used in the gate, not a realized fee. Off-path, block-pinned account
   snapshots include wallet balances, free margin and known bot order locks. The event's `account`
   reports snapshot equity, net P&L and excess over holding at that snapshot's price and block.
   It may lag the current block; snapshots wait for pending placements to resolve so their
   locks can be counted. Use a dedicated account with no pre-existing orders or external
   transfers: pre-existing unknown locks and deposits/withdrawals cannot be attributed correctly.
   Session inventory, losses and estimates currently reset at restart; the first snapshot is the
   account benchmark, not a reconstructed lifetime performance history.
6. **Recorded replay.** `data/research.jsonl` records books, prints as observed, model inputs,
   original forecasts, costs and policy settings. Replay trains chronologically before a chosen
   split, then evaluates later blocks with online updates using only matured past observations:

       SPLIT_BLOCK=123456 START_MON=600 START_USDC=20 bun run scripts/replay.ts data/research.jsonl

   Pick a split inside a long enough recording. Freeze parameters before reading the test results.
   Each run appends its parameters/results to `replay-trials.jsonl` so failed variants remain visible.
   Results include net P&L, excess over holding, an exit-cost-adjusted benchmark, drawdown, partial
   fills, reverts, gas, inference, and unresolved transactions/open orders at the boundary.
   `LATENCY_BLOCKS` defaults to 2. Replay consumes visible queue ahead before filling, delays
   placements/cancels, charges reverted sends and checks post-only crossing on inclusion.
   It reuses recorded Jev forecasts: changing portfolio inputs would require fresh inference, so
   this is an execution-policy experiment, not a full counterfactual AI backtest. L2 data does not
   reveal exact queue positions or intervening books. Replay ignores our own market impact and
   is an approximation, not proof of live profitability. Do not concatenate different settings,
   markets, model versions or sessions into one recording.

Additional settings are documented in `.env.example`. `MAX_LOSS_USD` stops quoting and cancels
orders; it does not liquidate inventory. `MAX_VOL_BPS` is measured per observed price update,
not annualized volatility. `EXIT_COST_BPS` should include realistic taker fees and market impact.
No historical market recording ships with this repository: collect one in dry-run mode and
inspect calibration and markouts before judging whether the strategy earns money.

Backend execution tests explicitly opt into legacy demo mode through `test/legacy-preload.ts`;
`strategy.test.ts` and `strategy-integration.test.ts` independently exercise the new policy.

## Deploy the dry-run demo

Deploy the backend Dockerfile to a Railway service with `DRY_RUN=true`, `MODEL=jev`,
`TYPESAFE_AI_API_KEY` configured as a secret, `STRATEGY_ENABLED=true`, and `RECORD_RESEARCH=true`.
Use a fresh persistent working directory for each research session, and preserve its `data/`
directory when exporting results. Do not enable live sends on the current inactive V1 market.

Deploy `web/` as a separate Vercel Next.js project. Set `NEXT_PUBLIC_API_URL` to the backend's
public HTTPS URL before building. Local checks are `bun test --coverage`,
`cd web && bun test --coverage`, and `cd web && bun run build`.

After deployment, check the backend `/` snapshot for the expected model and `dryRun: true`,
then verify that `/history` gains fresh blocks and the dashboard receives them through `/events`.
A listening server with an empty history is not a successful trading-demo validation. The
current empty V1 book must be resolved before this acceptance check can pass.
# jev_trade
