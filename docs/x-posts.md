# X market posts

`scripts/x-posts.mjs`, run by `.github/workflows/x-posts.yml`. Three events per market, fixed templates, chain data
only, no model. Plain text: no links, no mentions, no hashtags, no replies, likes, follows or reposts.

## Proposed wording (for approval)

Example values are the live Packers-Cowboys market; `{...}` is filled from chain data.

**Market opened**
```
Market open: Cowboys at Packers (NFL, Oct 18).
Line: pick'em.
Winners split the pool. One flat 2% fee on stake.
```
With a line: `Line: Packers -3.5.` (the favourite is named; `Z > 0` means home lays points).

**Betting closed**
```
Betting closed: Cowboys at Packers (NFL, Oct 18).
Closing line: Packers -4.5.
Stakes in the pool: $1,234.
```
With no real bets: `No bets were placed.` instead of the last line. Stakes exclude the protocol seed.

**Settled**
```
Final: Packers won by 7 (Cowboys at Packers, NFL, Oct 18).
Winners can claim their payouts now.
```
Away win: `Cowboys won by 3`. Tie: `Packers and Cowboys tied`. Cancelled and refund markets are never posted.

## Settled wording: margin, not score

The chain stores `finalSpread = home score - away score` (see `lib/line.ts`), so "Packers won by 7" is exact and
needs no outside data. A **final score** ("Packers 27, Cowboys 20") cannot be derived from it. If wanted, it needs a
sports-data source, e.g. The Odds API scores endpoint (free 500 credits/month; paid from $30/month for 50k credits;
a scores call costs credits per request) or ESPN's undocumented public endpoint (free, no SLA, no terms that permit
it). None is added here; this needs approval.

## Behaviour

- `X_POSTS_ENABLED` (repo variable) defaults to `false`; `DRY_RUN` defaults to `true`. Live needs `X_POSTS_ENABLED=true`
  and `DRY_RUN=false`. A dry run logs what it would post and writes no state.
- One post per event per market, recorded in `data/x-posts-state.json` after each post. Only the latest stage reached is
  posted; earlier ones are marked `superseded` (a market found already closed gets "Betting closed", not a stale "open").
- `data/x-posts-config.json` `notBefore` ignores markets whose gameId date is earlier (no backlog flood at go-live).
  A cap of 3 posts per run (`X_MAX_POSTS_PER_RUN`) is a second guard.
- Any failed post (403/429/401, any 4xx, 5xx, or no response) records the attempt, sets `disabled` in the state file,
  fails the run with an error annotation and posts nothing more, ever, until a human clears `disabled`. No retry.
- Markets come from `SportsbookFactory v1.6 getAllMarkets()` (last 25); older factories are not covered.

## Secrets (GitHub only)

`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (the posting app, OAuth 1.0a user context, app
permission "Read and write"), plus the existing `RPC_URL` and `FACTORY_ADDRESS`. Variables: `X_POSTS_ENABLED`,
optionally `X_POSTS_DRY_RUN`.
