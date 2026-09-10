# Even Steven — Market Opener Bot

Reads the NFL schedule CSV (`data/markets.csv` in the `even-steven` GitHub repo)
and deploys markets via `SportsbookFactory.createMarket(gameId, oracleZ)` on
Base mainnet. It also closes betting automatically at kickoff.

**Nothing deploys unless you personally approved it.** Four independent
controls gate every deployment.

---

## The four controls

### 1. Per-row approval (column K)
The bot deploys a row only if column K contains `yes`. Blank means never,
regardless of dates or status. The CSV is an opt-in list, not a schedule.
(This gate applies to opening new markets only — closing betting at kickoff
on an already-open market is automatic and not gated by approval.)

Your weekly routine: edit `data/markets.csv` in the `even-steven` repo, type
`yes` in column K for the games you want live, done. Everything else stays
inert.

### 2. Kill switch (`BOT_ENABLED`)
Anything other than exactly `true` and the bot reads the CSV, logs what it
would have done, and writes nothing. Stops the bot without touching the
GitHub Actions schedule.

### 3. Concurrent open markets cap (`MAX_OPEN_MARKETS`)
Counted live from the factory's `getOpenMarkets()`. When the cap is reached,
approved-and-due games are skipped with a `capped_skip` log and retried on the
next run. Because the count comes from the chain, it can't be reset by
deleting a local file.

Raising it later is one number in `.env` — no code change, no redeploy.

### 4. Dry run (`DRY_RUN`)
`true` simulates every deployment (and every betting-close) against real chain
state and logs `would_deploy` / `would_close`, without broadcasting anything
or touching the CSV.

Controls stack. Live deployment requires `BOT_ENABLED=true` **and**
`DRY_RUN=false` **and** the row approved **and** capacity under the cap.

---

## Other guarantees

- **Wallet identity is enforced twice** — at startup and again inside
  `deployMarket()`. Whoever calls `createMarket()` becomes that market's
  permanent fee owner, so a mismatched key aborts before any chain write.
- **`oracleZ` is always 0.** Deliberate protocol design (cold-start liquidity
  incentive), not a placeholder. There is no odds-fetching code anywhere here,
  and none should be added.
- **Never opens a market on a game that already started**, even if the row is
  approved and stale.
- **Timestamps must be strict ISO-8601 with a timezone.** `2026-08-20T23:00:00Z`
  is accepted; `8/20/2026` and `2026-08-20 23:00:00` are rejected loudly.
  Lenient parsing would silently shift kickoff by hours, or read 11/08 as November.
- **Reverted transactions are detected** via `receipt.status`, not assumed.
- **The Alchemy API key is scrubbed from all log output.** viem embeds the RPC
  URL in transport errors; the logger redacts it centrally.

---

## Setup

```bash
npm install
cp .env.example .env
```

Create a GitHub Personal Access Token with `contents: write` on the
`EvenStevenBet/even-steven` repo, then set `GITHUB_TOKEN` in `.env`. Also fill
in `RPC_URL` and `PRIVATE_KEY`. Everything else is pre-filled.

### CSV requirements
- Lives at `data/markets.csv` in `github.com/EvenStevenBet/even-steven`
- 11 columns: `gameId, sport, homeTeam, awayTeam, gameDate, status,
  marketAddress, openLine, bettingOpensAt, notes, approved`
- No commas or quotes in any value — parsed with a plain line/column split,
  no CSV library
- Blank separator rows (empty `gameId`) are skipped automatically
- Timestamps stored as strict ISO-8601 with timezone, as plain text

---

## Going live

Run each step and read the log before moving to the next.

**1. Kill switch on, dry run — confirms CSV access and wallet identity.**
```bash
npm start
```
Expect `mode: KILL_SWITCH_OFF`. Nothing else should happen.

**2. Dry run with the bot enabled — confirms the full pipeline.**
```
BOT_ENABLED=true
DRY_RUN=true
```
```bash
npm start
```
Now you should see balances, capacity, and `would_deploy` lines. **Check that
the games listed are exactly the ones you approved.** If nothing is approved
yet, approve one row and re-run.

**3. Live.**
```
DRY_RUN=false
```
```bash
npm start
```

Note: the very first live run will also attempt `closeBetting()` on any
already-open markets whose kickoff has passed — including the two preseason
markets in the seed CSV (kickoff Aug 22 and Aug 24, both long over). This is
expected and correct; those games are over and betting should be closed on
them regardless of when the bot happens to first run.

---

## Scheduling

Runs on GitHub Actions on a 15-minute schedule (`.github/workflows/market-opener.yml`),
so it no longer depends on a Mac staying awake.

In the `even-steven` repo, go to **Settings → Secrets and variables → Actions**
and add these 8 secrets:

- `BOT_ENABLED`, `DRY_RUN`, `MAX_OPEN_MARKETS`, `APPROVAL_TOKEN`
- `RPC_URL`, `PRIVATE_KEY`, `PRODUCTION_WALLET`, `FACTORY_ADDRESS`, `USDC_ADDRESS`
- `RECEIPT_TIMEOUT_MS`
- `BOT_GITHUB_TOKEN` — a PAT with `contents: write` on this repo. Named
  `BOT_GITHUB_TOKEN` rather than `GITHUB_TOKEN` because GitHub Actions
  reserves `GITHUB_TOKEN` as a built-in — using it as a secret name conflicts.

The workflow itself is already committed; once the secrets are set it runs
automatically every 15 minutes. Use **Actions → Market Opener Bot → Run
workflow** (`workflow_dispatch`) to trigger it manually for testing without
waiting for the schedule.

Concurrency is capped to one run at a time (`cancel-in-progress: false` — a
run in progress is never killed by the next scheduled tick), so overlapping
runs can't pick the same nonce.

---

## Reading the logs

One JSON object per line, in `logs/deploy-YYYY-MM-DD.jsonl`.

| Event | Meaning |
|---|---|
| `run_start` | Includes `mode`: LIVE, DRY_RUN, or KILL_SWITCH_OFF |
| `wallet_verified` | Signing key matched the production wallet |
| `open_market_capacity` | Currently open vs. cap |
| `approved_and_due` | Rows that passed every gate |
| `row_skipped` | Something probably worth fixing (typo, bad date) |
| `would_deploy` | Dry run — simulation succeeded, nothing broadcast |
| `deploy_success` | Real market created; includes address and tx hash |
| `sheet_updated` | Address written back to the CSV |
| `capped_skip` | Approved and due, but at the cap; retries next run |
| `deploy_failed` | That row failed; untouched, retried next run |
| `close_betting_check` | Count of currently open markets being checked for kickoff |
| `would_close` | Dry run — closeBetting() simulation succeeded, nothing broadcast |
| `close_success` | closeBetting() sent and confirmed on-chain |
| `close_already_done` | Market was already closed (by an earlier run or manually) — routine, not an error |
| `close_failed` | closeBetting() reverted or the row's data was unusable; retried next run |
| `close_no_csv_row` | An open market's gameId has no matching CSV row — skipped, can't know its kickoff time |

Ordinary non-deployments (not approved, window not open) are summarised in
`approved_and_due` rather than logged per row, to keep logs readable.

---

## Files

| File | Purpose |
|---|---|
| `src/config.ts` | Env loading, strict validation of every limit |
| `src/chain.ts` | viem clients, wallet guard, approval, deployment, closeBetting |
| `src/csv.ts` | GitHub CSV read and write-back (Contents API, no CSV library) |
| `src/eligibility.ts` | Every gating rule, including approval and dates |
| `src/logger.ts` | JSONL logging with credential redaction |
| `src/runner.ts` | Orchestration — deployment loop, then close-betting loop |
| `.github/workflows/market-opener.yml` | Scheduled run every 15 minutes via GitHub Actions |

---

## Scaling notes

- `getOpenMarkets()` loops over every market ever created and makes an external
  call per market. Fine at tens of markets; at several hundred this call gets
  slow and could eventually exceed an RPC node's gas cap for `eth_call`. If you
  scale that far, switch the cap to a subgraph or event-log query.
- Each market costs 2 USDC of protocol seed at creation, plus a 500 USDC UMA
  bond at settlement. The bond is the real constraint: games clustered on the
  same night settle together. Preseason week 3 has ten games on one Friday.
