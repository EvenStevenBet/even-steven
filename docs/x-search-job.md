# X lead search job

Read-only daily search of X recent posts for lead research. Writes one tab per day to the Google Sheet "ES - X Search".

- Code: `scripts/x-search.mjs` (job), `scripts/x-search-client.mjs` (the only file that talks to X: one GET endpoint).
- Queries: `data/x-search-queries.json` (reviewed by PR; validated on every run).
- Workflow: `.github/workflows/x-search.yml` (daily 13:30 UTC + manual dispatch).
- Not part of this job: the Grok Bot X connector, any model/agent, any posting or user-context X token.

## Setup (Jeff sets these; values never go in the repo)

| Name | Kind | Purpose |
|---|---|---|
| `X_BEARER_TOKEN` | secret | App-only Bearer Token of the read-only X app |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | Service account key; share the sheet with its email as Editor |
| `X_SEARCH_SHEET_ID` | variable | Id of the "ES - X Search" spreadsheet (from its URL) |
| `X_SEARCH_DAILY_CAP_USD` / `X_SEARCH_MONTHLY_CAP_USD` | variables | Hard caps in estimated dollars; unset = values in the config (3 / 25) |
| `X_SEARCH_ENABLED` | variable | Must be exactly `true` for the *scheduled* run to go live |

## Sheet layout

- `YYYY-MM-DD`: handle, post link, post text, date, query. Appended RAW; leading `= + - @` get a `'` prefix.
- `_state` (hidden): `since` per query and `seen` post ids (kept 8 days). Advanced only after rows are written.
- `_runs`: one row per run: time, date, mode, queries run, post reads, user reads, est. USD, day total, month-to-date, stop reason.

## Data retention

Every live run, after writing, deletes daily tabs whose exact `YYYY-MM-DD` name is more than 7 days old (a 7-day-old tab is kept), so post text and links are stored for at most 7 days. `_state`, `_runs` and any other tab are never touched. A dry run deletes nothing and logs what it would delete. The job keeps no post text beyond that: only one `since_id` per query and the post ids seen in the last 8 days (for dedupe) live on in `_state`. It stores no off-X data about the people in the posts.

## Cost model

$0.005 per post read, $0.010 per user read (docs.x.com pricing, checked 2026-11-15). Each request is sized so that,
even if every post returned a distinct user, it cannot pass the daily or monthly cap (worst case $0.015 per post).
X bills per unique resource per UTC day, so real cost is at or below the estimate. Spend is read back from `_runs`.
The sheet is the budget ledger: if `_runs` is edited or deleted the caps lose their memory.

## First live run

Manual dispatch, `dry_run` unticked, defaults (1 query, 10 posts, about $0.05-0.15). Needs Jeff's go.
Then set `X_SEARCH_ENABLED=true` to let the daily schedule go live.
