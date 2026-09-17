# Security Audit — September 2026 (Delta)

Delta audit for **SportsbookMarket v1.10** / **MarketDeployer v1.0** /
**SportsbookFactory v1.5**, covering only the changes from v1.9 / v1.4. Per project
convention this supplements (does not replace) `audit-april-2026.md`,
`audit-june-2026.md` and `audit-august-2026-delta.md`. Not a formal third-party audit.

---

## Why this delta exists

Even Steven is built agent-first, and x402 is the intended agent-native distribution
channel. The read-only x402 endpoints are live, but the write endpoint (`POST /api/bet`)
could not be built: `placeBet()` records `msg.sender` as the bettor, so any server-side
relay would have to custody agent funds to place a bet on their behalf. v1.10 adds
`placeBetFor()`, which lets a relay submit a bet that the *agent* owns, funded by the
agent's own EIP-3009 signature. The relay never holds agent funds.

Three smaller items ride along: the long-standing `getMarketEV()` quoting bug is fixed at
the source, the protocol seed becomes a per-market parameter that may be zero, and
`claimPayouts(uint256[])` adds batch claiming.

---

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| R6-1 | **Critical (design, caught pre-implementation)** | Using EIP-3009 `transferWithAuthorization` — the primitive x402 uses — would let any mempool observer redeem the bettor's authorization directly at USDC, moving funds into the market with no bet recorded and burning the nonce so `placeBetFor` then reverts | Resolved — `receiveWithAuthorization` used instead; it requires `msg.sender == to`, so the authorization is redeemable only from inside `placeBetFor()` |
| R6-2 | **High** | The EIP-3009 signature covers `(from, to, value, validAfter, validBefore, nonce)` but **not** `greaterThan`. A permissionless relay could take an authorization intended for one side of the line and place it on the other — as the bettor's counterparty | Resolved — the signed nonce must equal `keccak256(abi.encode(salt, greaterThan))`, checked before USDC is called, so a signature commits the bettor to one side |
| R6-3 | **High (build)** | v2 feature set pushes SportsbookFactory to 25,413 bytes — **837 bytes over the EIP-170 limit, undeployable.** The factory's runtime embeds the market's ~17 KB creation code, so every market byte costs a factory byte | Resolved — `new SportsbookMarket(...)` moved into `MarketDeployer`; factory drops to 8,048 bytes (16,528 headroom) with the market contract otherwise unchanged |
| R6-4 | Medium | `getMarketEV()` / `simulatePayout()` divided by a winning-side denominator that included the protocol seed, which `_sumWinningStakes()` never counts — the on-chain quote under-reported payouts, worst on thin pools | Resolved — seed excluded from the denominator; verified against realized settlement |
| R6-5 | Low (ABI) | Changing `createMarket()` breaks the market-opener bot | Accepted and contained — `createMarket` / `createMarketWithBounds` change by design; **every other consumed function and every event topic0 is byte-identical to v1.4/v1.9** (see ABI compatibility table) |
| R6-6 | Medium (mechanism) | A seedless market's Z-line did not move until *both* sides held stake, because `_updateZ()` returned early when either pool was zero. The seed was not only a divide-by-zero guard — it was also what let the first bet move the line | **Resolved** — a notional `Z_VIRTUAL_SEED` is applied inside `_updateZ()` only, on seedless markets only. Seedless Z now equals seeded Z at every stake size; seeded markets are bit-identical to v1.9. See R6-6 detail. |
| R6-7 | Informational | EIP-3009 failure modes surface as USDC's own revert *strings*, not custom errors, so agents must string-match rather than decode a 4-byte selector | Accepted — documented in AGENTS.md. Wrapping them would cost bytecode and lose USDC's detail. |
| R6-9 | Informational (design property, doc'd) | An agent needs native ETH to call `claimPayout()` itself. EIP-3009 makes *betting* gasless for the agent, but *claiming* is a direct call from the agent's address — an agent funded only in USDC cannot collect its winnings. Surfaced only by the live run; a fork hides it | Documented in AGENTS.md. A relayed `claimPayoutFor` is a **v3 candidate**, not needed for launch (90-day `CLAIM_TIMEOUT`) |
| R6-10 | Informational (operational) | Public RPC read-after-write staleness caused three false rehearsal failures — confirmed writes invisible to the next read, and to viem's pre-send `eth_call` simulation | Harness polls for visibility and pins reads to explicit blocks. Caution noted for the bot's `approve` → `createMarket` sequence on any load-balanced endpoint |
| R6-8 | **High (off-chain, blocks seedless launch)** | `Web App/lib/payout.ts` hardcodes `PROTOCOL_SEED = 1_000_000` rather than reading `protocolSeedTotal` from chain. Against a market created with `seed = 0` it subtracts a seed that does not exist and **over-quotes** the payout — on the bet slip and both x402 endpoints | **Mitigated by launch decision, not yet fixed.** v1.10 launches at 1 USDC/side, for which the existing client math is exact. The fix is a prerequisite of ever creating a seedless market. See R6-8 detail. |

---

### R6-1 detail — front-running the authorization

**Verified against live Base mainnet USDC, not assumed.** Circle's FiatTokenV2.2
(proxy `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` → implementation
`0x2Ce6311ddAE708829bc0784C967b7d77D19FD779`, resolved via the *zeppelinos* proxy slot,
not EIP-1967) was probed directly with `eth_call`:

```
receiveWithAuthorization  -> revert: "FiatTokenV2: caller must be the payee"
transferWithAuthorization -> revert: "FiatTokenV2: invalid signature"
```

The payee check fires *before* signature verification, confirming
`receiveWithAuthorization` is callable only by `to`. `transferWithAuthorization` applies
no caller restriction whatsoever — it is redeemable by anyone holding the signed blob.

Because `placeBetFor` is deliberately permissionless (no relay allowlist, consistent with
the protocol's no-owner-override posture), the authorization is necessarily public before
it lands. With `transferWithAuthorization` an observer could redeem it straight at USDC:
the bettor's `stake + fee` would transfer into the market contract, **no bet would be
recorded**, and the spent nonce would make the real `placeBetFor` revert. The bettor's
funds would sit in the market as un-bet balance.

`receiveWithAuthorization` closes this completely. It also *reduces* bytecode: USDC
performs the EIP-712 verification, so the market carries no domain separator, no
typehash and no `ecrecover`.

**Live test:** an outside account attempting to redeem a valid, unspent authorization
whose `to` was the market reverted with `FiatTokenV2: caller must be the payee`.

### R6-2 detail — the signature does not bind the side

EIP-3009 signs `(from, to, value, validAfter, validBefore, nonce)`. Mapping that onto a
bet:

- `from` binds the **bettor** — a valid signature proves this address authorized the spend.
- `to` binds **this market** — an authorization cannot be replayed against another market.
- `value` binds the **stake**: `value = stake + (stake * FEE_PERCENT / 10000)` is strictly
  increasing in `stake`, so exactly one stake maps to a given signed value. A relay that
  passes a different `stake` produces a different `value` and the signature fails.
- `validAfter` / `validBefore` bind the window.
- **`greaterThan` is bound by nothing.**

A hostile relay could therefore take an authorization the agent signed intending
"greater than" and submit it as "less than or equal", then take the other side itself.

**Fix.** The bettor signs a *structured* nonce:

```
nonce = keccak256(abi.encode(salt, greaterThan))
```

`placeBetFor` recomputes it from `auth.salt` and the `greaterThan` argument and rejects a
mismatch with `BadAuthorizationNonce()` **before** calling USDC. The signed nonce is now a
commitment to one side of the line.

**Consequence for integrators (documented in AGENTS.md):** this is a deliberate
divergence from a vanilla x402 payload, which uses a random nonce. A random nonce is
rejected with the distinct `BadAuthorizationNonce()` error rather than USDC's opaque
`"FiatTokenV2: invalid signature"`. Also note the nonce does **not** include the market
address: USDC tracks nonces per `(authorizer, nonce)` globally, so a `salt` must be unique
per bet across all markets for a given bettor, not merely per market.

**Live tests:** relay submitting a GREATER-signed authorization as LESS reverted
`BadAuthorizationNonce()`; an x402-style random nonce reverted `BadAuthorizationNonce()`;
replay of a spent authorization reverted `FiatTokenV2: authorization is used or canceled`;
an expired authorization reverted `FiatTokenV2: authorization is expired`; a mismatched
stake reverted `FiatTokenV2: invalid signature`.

### R6-3 detail — EIP-170 and the MarketDeployer split

A contract that executes `new SportsbookMarket(...)` embeds the market's **entire creation
bytecode** in its own runtime. That is why the v1.4 factory sat at 24,153 bytes with only
423 bytes of headroom: roughly two-thirds of it was market creation code.

Measured with the shipped compiler settings (solc 0.8.20+commit.a1b79de6, optimizer on,
runs=1, EVM shanghai). The v1.9/v1.4 baseline reproduced exactly, validating the harness:

| Build | Factory runtime | Headroom |
|---|---|---|
| v1.9 / v1.4 (live on mainnet) | 24,153 | 423 |
| v1.10 / v1.5, single-factory | **25,413** | **−837 — fails to deploy** |
| v1.10 / v1.5, MarketDeployer split (shipped) | **8,048** | **16,528** |

The factory no longer grows with the market contract — market creation code now lives in
MarketDeployer (17,650 bytes, 6,926 headroom), so future market changes spend the
deployer's headroom, not the factory's.

Marginal cost of each v2 item on the market contract:

| Change | Δ bytes |
|---|---|
| `placeBet` refactored into shared `_preBet` / `_recordBet` | **−307** |
| `getMarketEV` / `simulatePayout` fix | **−66** |
| configurable protocol seed | +99 |
| `claimPayouts(uint256[])` | **+957** |
| `placeBetFor` + EIP-3009 | +534 |

Note `claimPayouts` — scoped as the low-complexity item — is the largest single consumer,
nearly double `placeBetFor`. `placeBetFor` is cheap precisely because R6-1's
`receiveWithAuthorization` choice delegates signature verification to USDC.

**Shipped sizes (including R6-6):** MarketDeployer 17,650 · SportsbookFactory 8,048 ·
SportsbookMarket 16,254. All three under EIP-170 with margin.

**Trust model of the new contract.** `MarketDeployer.deploy()` is permissionless and
stateless; it holds no funds and has no owner. A market produced by calling it directly is
never registered in `marketByGameId` / `allMarkets`, is invisible to every factory view,
and is owned by whoever called it — an orphan contract, not a protocol market. The factory
pins the deployer as an `immutable` at construction, so it can never be swapped to mint
markets running different code under the same factory address.

**Residual risk.** Deployment order now matters: MarketDeployer must be deployed first and
its address passed to the factory constructor. A factory pointed at a wrong or hostile
deployer would produce markets running arbitrary code. This is a one-time deployment-time
check — verify the deployer address on BaseScan before deploying the factory, and confirm
`factory.deployer()` after.

### R6-4 detail — the quoting bug, fixed at the source

`_sumWinningStakes()` has never counted the protocol seed as a winning stake, but
`getMarketEV()` / `simulatePayout()` divided by a denominator that included it. The result
under-quoted, worst on thin pools, converging to correct as pools deepened. Settlement was
always correct; only the quote lied. The web app and x402 endpoints already worked around
this client-side (`lib/payout.ts`), but any agent calling the contract directly — the path
AGENTS.md's own Quick Start documents — got the wrong number.

**Fix.** The winning-side denominator now subtracts that side's seed, matching settlement:

```solidity
uint256 seedPerSide   = protocolSeedTotal / 2;
uint256 winningSide   = (greaterThan ? greaterPool : lessEqualPool) - seedPerSide + stake;
uint256 distributable = totalPool - protocolSeedTotal + stake;
```

`liquidPayout` is now `stake * 2` — at balanced real stake the winning side is exactly half
of `distributable`, so the payout is exactly 2×, not an approximation.

**Live proof.** On a seeded market with 100 USDC already on the losing side, the quote for
a 100 USDC bet was compared against the realized payout after a full UMA settlement:

```
v1.10 quote     : 200.000000
v1.9 quote      : 198.019801   <-- the bug
realized payout : 200.000000
```

On a **seedless** market the two formulas agree exactly (200.000000 both) — independent
confirmation that the seed in the denominator was the entire root cause.

### R6-6 detail — seedless markets froze the Z-line (resolved)

In v1.9, `_updateZ()` began:

```solidity
if (gPool <= 0 || lePool <= 0) return;
```

a correct divide-by-zero guard that relied on `PROTOCOL_SEED` being nonzero. Once the seed
became configurable, that early return fired whenever one side held no stake — which is
exactly the state a fresh seedless market is in for its entire one-sided opening window.

**Measured before the fix:** on a seedless market, 100 USDC on LESS left `currentZ` at the
opening `-35000`, unmoved. The equivalent seeded market moved to `-172247`. The dynamic
Z-line is the mechanism that attracts opposing flow, so it was dormant precisely when it
was most needed — which defeats a large part of the reason to run seedless at all.

**Fix.** A notional per-side seed, applied inside `_updateZ()` and nowhere else:

```solidity
int256 vSeed  = protocolSeedTotal == 0 ? Z_VIRTUAL_SEED : int256(0);
int256 gPool  = int256(greaterPool)   + vSeed;
int256 lePool = int256(lessEqualPool) + vSeed;
```

`Z_VIRTUAL_SEED` is `1e6` — the same 1 USDC/side seeded markets have used since v1.8.1.

It is applied to **both** sides rather than only to an empty one. An earlier iteration
substituted the notional value only for a zero pool; that fixed the freeze for most stakes
but left two discrepancies, both caught by measurement: below the 19:1 clamp the two modes
diverged slightly, and a lone **1 USDC minimum bet still froze the line** (the stake exactly
tied the virtual seed 1:1, producing `diff == 0`). Adding it to both sides reproduces seeded
behaviour exactly at every stake size.

**Containment.** `Z_VIRTUAL_SEED` appears in exactly two places: its declaration and
`_updateZ()`. It is never added to `greaterPool`, `lessEqualPool`, `totalPool` or
`protocolSeedTotal`; it never enters `distributable`; it never reaches `_calculatePayout()`
or `_sumWinningStakes()`. The diff against the pre-fix file touches only the constant
declaration and the first three lines of `_updateZ()`. Both pools remain strictly positive
in either branch — seeded markets hold at least `PROTOCOL_SEED` per side, seedless markets
receive `vSeed` — so the divide-by-zero the original guard existed to prevent stays
impossible.

**Verification — seedless now equals seeded at every stake size:**

| One-sided stake (LESS) | Seeded Z (1 USDC/side) | Seedless Z (virtual) | Identical |
|---|---|---|---|
| 1 USDC | −69,657 | −69,657 | yes |
| 5 | −124,187 | −124,187 | yes |
| 10 | −151,801 | −151,801 | yes |
| 18 | −172,247 | −172,247 | yes |
| 19 | −172,247 | −172,247 | yes |
| 20 | −172,247 | −172,247 | yes |
| 25 | −172,247 | −172,247 | yes |
| 50 | −172,247 | −172,247 | yes |
| 100 | −172,247 | −172,247 | yes |
| 500 | −172,247 | −172,247 | yes |

(Values pin at −172,247 from 18 USDC upward because the 19:1 `MAX_POOL_RATIO` clamp binds.)
Symmetry confirmed on the GREATER side: both modes give `+102,247` at 100 USDC. Before any
bet, `currentZ == initialZ` in both modes.

**Verification — seeded markets are unchanged from v1.9.** `vSeed` is zero whenever
`protocolSeedTotal > 0`, so seeded markets execute the same arithmetic as v1.9. Confirmed by
deploying v1.9 and v1.10 side by side and comparing `currentZ` after an identical bet:
identical at 1, 5, 10, 18, 19, 25, 100 and 500 USDC.

**Payout accounting unaffected.** The full settlement cycle was re-run after the fix in both
seed modes: both still pay exactly 2× stake (200.000000 USDC on a 100 USDC stake) through a
real UMA settlement, and all 58 assertions across the three suites pass.

**Cost.** +28 bytes on the market contract (16,226 → 16,254).

---

## ABI compatibility (downstream dependency check)

The v1.9 redeploy succeeded partly because `MarketCreated` and `getMarketInfo()` stayed
byte-identical to v1.3. The same discipline was applied here and verified by diffing
compiled ABIs, not by inspection.

| Surface | Result |
|---|---|
| `getMarketState`, `getBet`, `getBetsByAddress`, `claimPayout`, `claimAllPayouts`, `closeBetting`, `placeBet`, `getMarketEV`, `simulatePayout`, `requestSettlement`, `executeSettlement`, `getMarketStatus`, and all public state getters | **Unchanged** |
| `marketByGameId`, `getOpenMarkets`, `getMarketInfo`, `getAllMarkets`, `getMarketCount`, `gameIdByMarket`, `getUnsettledMarkets`, `getRefundableMarkets` | **Unchanged** |
| **Every event topic0**, including `MarketCreated` and `BetPlaced` | **Unchanged** |
| `createMarket(string,int256)` | → `createMarket(string,int256,uint256)` **BREAKING** |
| `createMarketWithBounds(string,int256,int256,int256)` | → `…,uint256)` **BREAKING** |
| New: `placeBetFor(address,bool,uint256,(uint256,uint256,bytes32,bytes32,uint8,bytes32,bytes32))` | selector `0x5b007a4f` |
| New: `claimPayouts(uint256[])` | selector `0x3d695c52` |

**Impact:** the market-opener bot needs exactly one change — the `createMarket` call. The
web app needs **zero** ABI changes. Indexers need zero changes.

---

## Revert-reason audit for `placeBetFor` (scope item 5)

All 43 market errors and 12 factory errors appear in the compiled ABI, so agents can
decode them by name rather than by raw selector. Every failure mode originating in *our*
contract has a custom error:

| Failure mode | Error | Machine-readable |
|---|---|---|
| Betting closed | `BettingIsClosed()` | custom error |
| Market settled/canceled | `MarketEnded()` | custom error |
| Stake below 1 USDC | `BelowMinBet()` | custom error |
| Market at MAX_BETS (1000) | `MarketFull()` | custom error |
| `bettor == address(0)` | `InvalidBettor()` | custom error (new) |
| Nonce not bound to this side / x402-style random nonce | `BadAuthorizationNonce()` | custom error (new) |
| Fee sweep to owner fails (e.g. owner blacklisted) | `FeeTransferFailed()` | custom error |

**Gaps (accepted, not fixed in v2 per scope):**

| Failure mode | Surfaces as | Note |
|---|---|---|
| Bad signature | `"FiatTokenV2: invalid signature"` | USDC string |
| Expired authorization | `"FiatTokenV2: authorization is expired"` | USDC string |
| Not yet valid | `"FiatTokenV2: authorization is not yet valid"` | USDC string |
| Nonce already spent / canceled | `"FiatTokenV2: authorization is used or canceled"` | USDC string |
| Insufficient balance | `"ERC20: transfer amount exceeds balance"` | USDC string |
| Bettor blacklisted by Circle | `"Blacklistable: account is blacklisted"` | USDC string |
| Market paused | `"Pausable: paused"` | OpenZeppelin string |

These are stable, documented and individually distinguishable by text, but they are
strings rather than 4-byte selectors. Catching and re-throwing them as custom errors would
cost bytecode and discard USDC's detail. Recommendation: document the exact strings in
AGENTS.md (done) and treat selector-ising them as a v3 candidate.

## Event-sufficiency audit for `BetPlaced` (scope item 6)

```solidity
event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake,
                uint256 fee, bool greaterThan, int256 lockedZ);
```

**Verdict: sufficient — no change needed.** Confirmed live that `bettor` carries the
EIP-3009 **signer**, not the relay's `msg.sender`, in the `placeBetFor` path. An agent can
reconstruct its full ledger from events alone: identity, bet id, stake, fee, side, and the
locked line. The market address comes free as `log.address`; `gameId` is a one-time
per-market lookup, not per-bet.

Win/loss is also derivable from events alone: `MarketSettled` carries `finalSpread`
(indexed), and the win condition is
`greaterThan ? finalSpread * 10000 > lockedZ : finalSpread * 10000 <= lockedZ`.

**Two v3 candidates (flagged, not built):**

1. The **payout amount** is not derivable from events — it needs `totalPool`,
   `protocolSeedTotal` and `cachedWinningStakes` read from the contract. Adding
   `distributable` and `cachedWinningStakes` to `MarketSettled` would close this. That is a
   `MarketSettled` shape question, not a `BetPlaced` one.
2. `PayoutClaimed(address,uint256)` emits a single aggregate for `claimAllPayouts()` and
   `claimPayouts()`, so an agent cannot attribute an aggregate claim to specific bet ids
   from events alone.

---

## Live verification (Base mainnet fork, Sept 13, 2026)

Run against a fork of Base mainnet at block ~51,288,122 — i.e. against the **real** Circle
USDC contract and the **real** UMA OptimisticOracleV3, not mocks. Contracts were compiled
with the pinned solc 0.8.20 artifacts and deployed as raw bytecode; the node enforced
EIP-170 (`allowUnlimitedContractSize: false`).

UMA minimum bond on Base read live: **500 USDC** — matches the documented operational fact.

**Core `placeBetFor` flow (15/15):** agent signed an EIP-3009 `ReceiveWithAuthorization`;
a separate relay account submitted `placeBetFor`; gas 275,810.

- `bet.bettor` and `BetPlaced.bettor` are the **agent**, not the relay
- `getBetsByAddress(agent)` has the bet; `getBetsByAddress(relay)` is empty
- agent paid exactly 102 USDC (100 stake + 2 fee)
- **relay USDC balance unchanged at 0 — the relay never custodies funds**
- **owner received exactly 2.000000 USDC — the 2% fee routes correctly even though the
  relay, not the bettor, is `msg.sender`**
- `greaterPool` and `totalPool` each increased by exactly 100 — **stake only, fee never
  enters the pool**
- market USDC balance equals `totalPool`, no fee residue

**Security negatives (7/7):** all listed in R6-1 / R6-2 above.

**R6-6 re-verified post-fix:** seedless Z now moves to −172,247 on one-sided flow, matching
the seeded market exactly.

**Full settlement cycle, both seed modes:** create → bets → `closeBetting` →
`requestSettlement` (500 USDC bond) → advance past the 7,200s liveness →
`executeSettlement` (`MarketSettled` with `viaOracle = true`) → **agent claims its own
payout directly, with no relay involvement**, receiving exactly 200.000000 USDC (2× stake)
in both the seeded and seedless markets. Claim gas 97,783.

**Batch claim (10/10):** `claimPayouts([2 bets])` paid the exact sum (266.666666), gas
137,215. Reverts confirmed: `NothingToClaim` on an empty array, `NotYourBet` on another
bettor's id, `InvalidBetId` out of range, and **`AlreadyClaimed` on an already-claimed id
inside the array — identical to the single-claim path.** A reverted batch is atomic: the
untouched bet remained claimable afterwards.

---

### R6-8 detail — client quote math assumes a 1 USDC seed exists

Making the protocol seed configurable is a contract change with an **off-chain** blast
radius. `Web App/lib/payout.ts` carries the client-side workaround for the R6-4 quoting bug
and strips the seed from the winning-side denominator — but it does so with a hardcoded
constant:

```ts
export const PROTOCOL_SEED = BigInt(1_000_000) // 1 USDC, matches the on-chain constant
...
const realWinningStake = winningSide - PROTOCOL_SEED
```

It reads `protocolSeedTotal` from chain for `distributable`, but not for this subtraction.
That constant reaches three consumers — `components/BetSlip.tsx`, `app/api/bet/quote/route.ts`
and `app/api/markets/agent/route.ts` — i.e. the entire user-facing *and* agent-facing quote
surface.

Against a `seed = 0` market it subtracts 1 USDC of seed that is not there, shrinking the
denominator and **over-quoting**:

| Opposing pool | Quote stake | Client says | Truth | Error |
|---|---|---|---|---|
| 1 USDC | 1 | **0.00** | 2.00 | **−100%** |
| 5 | 5 | 12.50 | 10.00 | **+25%** |
| 10 | 10 | 22.22 | 20.00 | +11% |
| 100 | 100 | 202.02 | 200.00 | +1% |
| 5,000 | 100 | 5,151.52 | 5,100.00 | +1% |

Against a seeded market the same code is exact at every row.

Two things make this worse than the R6-4 bug it was written to fix. It **over**-quotes,
promising money settlement will not pay, where R6-4 under-quoted. And its error is largest
on thin pools — which is precisely the state of a newly created market. A 1 USDC bet on a
fresh seedless market would display a **$0 payout**.

**Resolution.** v1.10 launches with `seed = 1 USDC/side`, for which the existing client math
is exact, so the contract deploy requires no app change. Before the bot is ever flipped to
`seed = 0`, `payout.ts` must either read `protocolSeedTotal / 2` from the market or — better
— drop the workaround entirely, since v1.10's on-chain `getMarketEV()` is now correct at the
source (R6-4).

**Note for the eventual fix:** with v1.10 deployed, the cleanest change is deletion, not
patching. The workaround exists only because the contract lied; it no longer does.

---

## Live Base Sepolia rehearsal (Sept 17, 2026) — PASSED

Full non-custodial cycle executed on Base Sepolia with real UMA liveness (no fast-forward).
Re-verifiable from chain with `node scripts/sepolia-rehearsal.mjs verify`, which sends no
transactions and re-reads every value at the block of the transaction it checks:
**32 assertions, 0 failures.**

| Step | Transaction | Result |
|---|---|---|
| Deploy MarketDeployer | `0x7aec70c9…dcd9` | `0xe789fc51…cd99`, runtime **17,650** bytes |
| Deploy SportsbookFactory | `0xdd62af79…c250` | `0xa4c679ce…13d5`, runtime **8,048** bytes |
| `setSettlementIdentifier("ASSERT_TRUTH")` | — | Sepolia-only; mainnet keeps `ASSERT_TRUTH2` |
| `createMarket(gameId, -35000, 1e6)` | `0x5920a1f6…787e` | market `0xE1F309B3…819E`, runtime **16,254** bytes |
| **`placeBetFor` (relay submits)** | `0x76ca1a6b…2ad7b` | block 46,950,354, gas **273,371** |
| Opposing `placeBet` | `0x41472cb2…cd778` | block 46,950,358 |
| `requestSettlement(0)` | `0xdffedfba…f469` | assertion `0xa96b5201…0d7b`, bond 100 USDC |
| `executeSettlement` | `0xcaed271f…9e51` | after **7,629s** real liveness |
| **`claimPayout` (agent submits)** | `0x2739cfb2…338e` | block 46,954,287, gas 114,871 |

**Ownership — the core claim of this release.** `placeBetFor` was submitted by relay
`0x4aeA0E5D…AD5b`; the transaction's `from` is the relay, yet the decoded event reads:

```
BetPlaced(bettor=0xAbaDCEF1…2BB3, betId=0, stake=1.00, fee=0.02, greaterThan=true, lockedZ=-35000)
```

`bettor` is the EIP-3009 **signer**, not `msg.sender`. Stored `bet.bettor` agrees.

**Fee routing and pool accounting**, as exact deltas between blocks 46,950,353 and
46,950,354 (pinned, not read at "latest"):

| | Δ |
|---|---|
| agent USDC | **−1.02** (stake + 2% fee) |
| relay USDC | **0.00** — never custodies |
| owner USDC | **+0.02** — exactly the 2% fee |
| `greaterPool` | **+1.00** — stake only |
| `totalPool` | **+1.00** — fee never enters the pool |

**R6-6 confirmed live.** Z moved −35,000 → **−343** on the one-sided bet. That is the exact
expected arithmetic for pools (2,1): `ln(2) ≈ 0.6931`, `zAdjust = 50000 × 0.6931 = 34,657`,
`−35000 + 34657 = −343`. Independent confirmation that `vSeed = 0` leaves a seeded market
behaving identically to v1.9.

**R6-4 confirmed live.** At pools greater=2 / lessEqual=2 / seed=2, `getMarketEV` returned
**1.50**; the unpatched v1.9 formula yields **1.00** — a 33% under-quote, exaggerated here
because the seed is large relative to a thin pool. `liquidPayout` exactly 2×, `impliedVig`
200 bps.

**Settlement and self-claim.** `MarketSettled(finalSpread=0, refundMode=false,
viaOracle=true)` through the real UMA OOv3. Post-settlement the market held exactly
`distributable` (2.00) — the 1 USDC/side protocol seed was returned. The agent then claimed
**itself**: claim tx `from` is the agent, the relay appears nowhere in it.
`PayoutClaimed(bettor=agent, amount=2.00)`, a USDC `Transfer` of 2.00 market → agent in the
same transaction, agent balance 0 → 2.00 across the claim block, market drained to 0.
`stake 1 × distributable 2 ÷ cachedWinningStakes 1 = 2.00` — exactly 2×, matching the
contract's settlement formula.

### Security negatives re-confirmed live (raw `eth_call`, no transactions sent)

The fork run proved these; they were re-confirmed against the deployed Sepolia market by
decoding revert selectors from raw `eth_call` responses. The R6-2 nonce check sits before
`_preBet()`, so it still fires on a closed market — which is what makes this testable after
settlement at zero cost:

| Probe | Revert |
|---|---|
| x402-style **random** nonce | **`BadAuthorizationNonce()`** |
| Side-flip: nonce bound to `true`, submitted as `false` | **`BadAuthorizationNonce()`** |
| Zero-address `bettor` | `InvalidBettor()` |
| Correctly derived nonce | `BettingIsClosed()` — i.e. it **passes** the nonce check and hits the next guard |

The last row is the control: it confirms a correctly derived nonce is accepted and that the
ordering is as designed, so the first two rows are genuine rejections rather than an
unconditional failure.

### R6-9 — an agent needs native gas to claim, even though betting is gasless

**Found only by running live.** The rehearsal's first claim attempt failed with
`gas required exceeds allowance (0)`: the agent wallet held USDC but no ETH.

This is not a contract defect, it is a property of the design worth stating plainly.
EIP-3009 makes **placing** a bet gasless for the agent — the relay pays gas, the agent only
signs. But **claiming** is a direct `claimPayout()` call from the agent's own address, so
the agent must hold native ETH. An agent funded purely in USDC can enter a position and
then be unable to collect its winnings.

A forked test cannot surface this: balances there are simply set. Mitigations for
integrators (documented in AGENTS.md): hold a small ETH balance for claims, or wait for a
`claimPayoutFor`-style relayed claim, which is a **v3 candidate** — it is not in v2 and is
not required for launch, since the 90-day `CLAIM_TIMEOUT` gives ample time to acquire gas.

### R6-10 — public RPC read-after-write staleness (operational, not a contract issue)

Three rehearsal attempts failed before one succeeded, all from the same cause:
`sepolia.base.org` load-balances across nodes, so a read issued immediately after a
confirmed write routinely lands on a node that has not caught up. Observed: `deployer()`
reverting moments after deployment; `setSettlementIdentifier` and `approve` both confirmed
on-chain yet invisible to the next call; `getBet(0)` reverting `InvalidBetId()` after a
successful bet; and the final claim's balance delta reading as 0.

It bites **writes** too, because viem simulates via `eth_call` before sending — a
`createMarket` was rejected with "transfer amount exceeds allowance" against an allowance
that was already `MAX` on chain.

Every one of these was a false signal; on-chain state was correct in all cases. The harness
now polls until each write is visible and pins before/after reads to explicit block heights.

**Relevance to mainnet:** the market-opener bot performs `approve` → `createMarket` in
sequence. On an RPC with the same behaviour that sequence can fail spuriously. The bot uses
Alchemy, which is read-your-writes consistent, so this is a caution rather than a defect —
but any future move to a public/load-balanced endpoint should carry a visibility check
between the approval and the create.

---

## Base Sepolia environment differences (pre-flight for the rehearsal)

Verified on-chain against Base Sepolia, because a rehearsal that trips on either of these
would look like a v1.10 defect when it is not:

| | Base Sepolia | Base mainnet |
|---|---|---|
| USDC `name()` | `"USDC"` | `"USD Coin"` |
| USDC `version()` | `"2"` | `"2"` |
| USDC implementation | `0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5` | `0x2Ce6311ddAE708829bc0784C967b7d77D19FD779` |
| `receiveWithAuthorization` payee check | enforced | enforced |
| **`ASSERT_TRUTH` whitelisted** | **true** | **false** |
| **`ASSERT_TRUTH2` whitelisted** | **false** | **true** |
| `oo.defaultIdentifier()` | `ASSERT_TRUTH` | `ASSERT_TRUTH` (not whitelisted) |
| `oo.getMinimumBond(USDC)` | 0 (market floors at `MIN_BOND` = 100 USDC) | 500 USDC |

Two consequences:

1. **The EIP-712 domain differs by `name`.** A signing client that hardcodes `"USD Coin"`
   produces signatures that Sepolia USDC rejects as invalid. Read `name()` from the token
   rather than hardcoding it.
2. **The whitelisted identifier is inverted between the two networks.** The factory ships
   defaulting to `ASSERT_TRUTH2` (correct for mainnet), so a Sepolia rehearsal must call
   `setSettlementIdentifier("ASSERT_TRUTH")` before creating its test market, and must not
   carry that call to mainnet. The rehearsal harness does this automatically.

Note that mainnet `oo.defaultIdentifier()` still returns `ASSERT_TRUTH`, which is *not*
whitelisted on mainnet — the original C-1 failure mode from the August delta is still live
in UMA's own default. v1.9's decision to make the identifier an explicit parameter remains
load-bearing.

---

## What this delta does not cover

- **MAX_BETS = 1000 remains unchanged**, deliberately. Removing it requires replacing the
  O(n) settlement loop with a sorted cumulative-stake structure — a v3 effort.
- The **1,000-bet settlement gas profile** was not re-measured here; the prior v1.9
  measurement (~$0.15) stands as the baseline.
- ~~No live Base Sepolia rehearsal~~ — **completed Sept 17, 2026. See "Live Base Sepolia
  rehearsal" below.**
- Open/permissionless market creation, `createMarketWithBoundsAndFee()`, predetermined
  betting close time, PRBMath `ln()`, minimum pool size, factory view pagination and UMA
  home/away sign convention are all untouched and remain backlog.
- This is not a formal third-party audit.

## Auditors

Claude Opus (delta round 6), September 13, 2026. Verification performed against live Base
mainnet state and a pinned Base mainnet fork, not against source reading alone.
