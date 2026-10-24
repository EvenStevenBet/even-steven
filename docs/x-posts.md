# X market posts

`scripts/x-posts.mjs`, run by `.github/workflows/x-posts.yml`. Three events per market, fixed templates, chain data
only, no model. Plain text: no links, no mentions, no hashtags, no replies, likes, follows or reposts.

## Wording

Approved by Jeff for this PR; `{...}` is filled from chain data. Tests assert these exact strings.

| Event | Text |
|---|---|
| Market opened | `{Away} at {Home} is open. Line: {Team} by {x}. Back either side at even money. The spread moves to balance the pool, so $100 wins $100.` |
| Betting closed | `Betting is closed on {Away} at {Home}. Line closed at {Team} by {x}.` |
| Settled | `Final: {Team} won by {n}. Winners split the pool.` |

- Pick'em (line of zero): `Line: pick'em.` and `Line closed at pick'em.`
- Tie (`finalSpread` of zero): `Final: {Home} and {Away} tied. Winners split the pool.`
- Doubleheader: `, game 1` or `, game 2` follows the matchup (`Blue Jays at Red Sox, game 1 is open.`). Without it two games would
  post identical text, and X rejects a duplicate as an error, which would disable posting.
- The opened post's last two sentences are Jeff's approved even-money sentence from ES - Context, word for word (pitch sentence 2, early line edge, is deliberately not used). It is the only place a post may say "$100 wins $100"; the closed and settled posts carry no dollar figure.
- No fee line, no claim line, no multiple, no pool size, and never any builder-code, affiliate, referral, points, 30% or market-creation wording (a test enforces it). A cancelled or refund-mode market produces no post (tested at the stage check and end to end).
- The team named is the favourite: home is quoted at `-Z`, so `Z > 0` means home lays points.

Example for the live Packers-Cowboys market (a pick'em):
`Cowboys at Packers is open. Line: pick'em. Back either side at even money. The spread moves to balance the pool, so $100 wins $100.`

## Settled wording: margin, not score

The chain stores `finalSpread = home score - away score` (see `lib/line.ts`), so "Packers won by 7" is exact and
needs no outside data. A final score cannot be derived from it and no sports-data source is used.

## Behaviour

- Two switches, both off by default: repo variable `X_POSTS_ENABLED` (default `false`) and the dry-run flag (default
  `true`). A dry run logs what it would post and writes no state.
- **To post from the scheduled runs, set both** `X_POSTS_ENABLED=true` **and** `X_POSTS_DRY_RUN=false` (repo variables).
  Without `X_POSTS_DRY_RUN=false` scheduled runs stay dry. A manual dispatch ignores the variable and uses its own
  `dry_run` input (default true).
- One post per event per market, recorded in `data/x-posts-state.json` after each post. Only the latest stage reached is
  posted; earlier ones are marked `superseded` (a market found already closed gets "Betting is closed", not a stale "open").
- **Go-live cutoff.** The repository variable `X_POSTS_NOT_BEFORE` (an ISO 8601 time such as `2026-10-26T00:00:00Z`, or a
  UTC date) is the cutoff. An event is skipped if its own on-chain time is earlier: the market's creation block for
  "opened" (a market stores no open time, so it is found by binary search over `eth_getCode`), `bettingClosedAt` for
  "closed", `settledAt` for "settled". A market whose open time cannot be determined is skipped, never guessed. **Live mode
  refuses to start, with an error, if the variable is unset.** In a dry run, unset means no time filter. There is no config
  file. A cap of 3 posts per run (`X_MAX_POSTS_PER_RUN`) is a second guard.
- **"Final" means resolved, not asserted.** A market counts as settled only when `settled()` is true, which the contract sets
  in `_settleMarket`, reached from `executeSettlement()` after UMA's `settleAndGetAssertionResult` returns true. A settlement
  that is only asserted (`assertionActive`), disputed, or rejected never posts. A settled market that ends in refund mode
  (no winning stakes) posts nothing.
- Any failed post (403/429/401, any 4xx, 5xx, or no response) records the attempt, sets `disabled` in the state file,
  fails the run with an error annotation and posts nothing more until a human clears `disabled`. No retry.
- Markets come from `SportsbookFactory v1.6 getAllMarkets()` (last 25); older factories are not covered.
- The script reads market state from the chain over RPC, not from evensteven.bet.

## Secrets (GitHub only)

`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (the posting app, OAuth 1.0a user context, app
permission "Read and write"), plus the existing `RPC_URL` and `FACTORY_ADDRESS`. Variables: `X_POSTS_ENABLED`, `X_POSTS_NOT_BEFORE` (required to go live),
`X_POSTS_DRY_RUN`.
