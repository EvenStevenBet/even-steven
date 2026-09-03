# Security Audit — August 2026 (Delta)

Delta audit for **SportsbookMarket v1.9** / **SportsbookFactory v1.4**, covering only
the changes from v1.8.1 / v1.3. Per project convention, this supplements (does not
replace) `audit-april-2026.md` and `audit-june-2026.md`. Not a formal third-party audit.

---

## Why this delta exists

On Aug 29, 2026, every market ever deployed by SportsbookFactory v1.3 was discovered to
be permanently unsettlable. `SportsbookMarket.requestSettlement()` hardcoded
`oo.defaultIdentifier()` as the UMA assertion identifier. On Base mainnet this resolves
to `ASSERT_TRUTH`, which UMA deprecated Dec 15, 2025 (UMIP-191) and removed from Base's
`IdentifierWhitelist`. Every `assertTruth()` call reverts. No funds were lost — the bond
transfer happens before the revert and is rolled back with it — but no deployed market
can reach `executeSettlement()`.

This bug passed five prior audit rounds because it is a **runtime-only failure**: it only
manifests against the live, governance-controlled `IdentifierWhitelist` on a network with
full DVM support. Static analysis of the Solidity source cannot see it — `defaultIdentifier()`
is a normal, well-typed external view call with no red flags in isolation.

---

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| C-1 | Critical | Hardcoded `oo.defaultIdentifier()` resolves to a deprecated, non-whitelisted UMA identifier — every settlement reverts | Resolved — identifier is now a constructor parameter (`ASSERTION_IDENTIFIER`) |
| H-5 | High (carried from roadmap as PE-1) | `claimPayout()` / `claimAllPayouts()` gated by `whenNotPaused` — owner pause after settlement can permanently trap already-settled bettor funds | Resolved — `whenNotPaused` removed from both claim functions |
| — | — | Factory has no path to update the identifier without a full redeploy if UMA changes it again | Resolved — `settlementIdentifier` is now owner-settable per `setDefaultFee()` pattern; locked per-market at creation time |
| R-2 | Medium | Adding `bytes32 identifier` to `MarketCreated` / `getMarketInfo()` changes topic0 and the return tuple, silently breaking the market-opener bot's ABI and any web-app caller | Resolved — both signatures reverted to be byte-identical to v1.3; identifier is read via `market.ASSERTION_IDENTIFIER()` instead |
| R-4 | High (identified, then descoped — see detail) | Owner going dark (lost key / hostile pause) while `bettingOpen == true` permanently traps all bettor funds — no path to refund exists for anyone | **Not shipped.** Fix was implemented and verified working, then deliberately removed before mainnet to keep MVP scope minimal — see R-4 detail. Pre-existing v1.8.1 behavior ships unchanged. |
| R-5 | High (build) | Factory deployed bytecode is 24,523 bytes at optimizer runs=200 — only 53 bytes under the EIP-170 limit; **39,147 bytes with optimizer off, which fails to deploy** | Mitigated — documented mandatory compiler settings (optimizer on, runs=1). Final shipped size: **24,153 bytes, 423 bytes headroom** (with R-4 removed; see R-4 detail). |

### C-1 detail

**Root cause.** `requestSettlement()` called `oo.assertTruth(..., oo.defaultIdentifier(), ...)`
instead of accepting the identifier as configuration. `defaultIdentifier()` is UMA's own
suggestion of "whatever OOv3 currently considers default," which changed silently from
the contract author's perspective when UMA executed UMIP-191.

**Fix.** `SportsbookMarket` v1.9 constructor takes a new `bytes32 _identifier` parameter,
stored as `ASSERTION_IDENTIFIER` (immutable, locked per market at deployment — consistent
with how `FEE_PERCENT` is already locked per market). `requestSettlement()` now passes
`ASSERTION_IDENTIFIER` instead of calling `oo.defaultIdentifier()`. `SportsbookFactory` v1.4
adds an owner-settable `settlementIdentifier` (default `bytes32("ASSERT_TRUTH2")`) passed to
every new market at creation, plus `setSettlementIdentifier()` so a future UMA identifier
change updates only factory state, never contract bytecode.

**Verification status — CONFIRMED.** `IdentifierWhitelist.isIdentifierSupported(bytes32("ASSERT_TRUTH2"))`
was queried against Base mainnet's live `IdentifierWhitelist`
(`0xAd517D72B9Cd31F578197D5e903d041B88c69795`, resolved via UMA's `Finder` at
`0x7E6d9618Ba8a87421609352d6e711958A97e2512`) on Aug 31, 2026 and returned **`true`**.
`ASSERT_TRUTH2` is whitelisted on Base mainnet. Cross-checked: `ASSERT_TRUTH` returns
`false`, independently confirming the root cause from the other direction.

**Residual risk.** None introduced by the fix itself. The configurable-identifier pattern
means a future UMA governance change of this kind becomes a `setSettlementIdentifier()`
call plus new markets going forward, not another audit-to-mainnet cycle — this is the
structural fix, independent of whether `ASSERT_TRUTH2` specifically turns out to be
correct.

### H-5 (PE-1) detail

**Root cause.** `claimPayout()` and `claimAllPayouts()` both carried `whenNotPaused`.
`pause()` is `onlyOwner` with no other restriction. A malicious or compromised owner key
could call `pause()` after a market settles and before bettors claim, permanently
blocking withdrawal of funds that are already, unambiguously owed — pausing does not
undo settlement, it only blocks the claim path.

**Fix.** `whenNotPaused` removed from both functions. `pause()` still blocks `placeBet()`,
`openMarket()`, `requestSettlement()`, and `executeSettlement()` — i.e., it can still stop
new exposure and new settlement actions — but can never freeze money already owed.

**Residual risk.** None identified. `nonReentrant` is unaffected and still applies to both
functions.

---

### R-4 detail (identified, fixed, verified working, then deliberately descoped)

**Root cause.** In v1.8.1 the only paths out of an open market were `closeBetting()`
and `cancelMarket()`, both `onlyOwner`; `placeBet()` is `whenNotPaused`; and
`triggerRefund()` required `bettingClosedAt > 0`, which only those owner-only functions
set. So if the owner key was lost, or the owner paused the market while betting was
open and never returned, every bettor's stake was permanently unrecoverable — by
anyone, forever. This is strictly worse than the PE-1 issue that was already scheduled
for fixing, and follows from exactly the same principle.

**Fix (built and verified, not shipped).** A version was implemented: `bettingOpenedAt`
recorded in `openMarket()`, `triggerRefund()` gaining a second permissionless path
(still open, 30d from `bettingOpenedAt`), `canTriggerRefund()` mirroring both paths.
This compiled clean and was reasoned through for correctness (30-day window unreachable
during any legitimate market lifecycle, cannot race normal settlement, both paths still
gated on `!settled && !canceled`).

**Decision: removed before mainnet.** After the testnet rehearsal proved the actual
launch blocker (C-1) fixed, the R-4 addition was assessed as scope creep against the
MVP goal — it consumed real bytecode budget (71 of the ~271 bytes the v1.9 changes cost
in total) solving a problem adjacent to, not part of, the identifier bug this release
exists to fix. Reverted to v1.8.1's original single-path `triggerRefund()` before
mainnet deployment. Shipped contracts have this gap, unchanged from every prior version.

**Residual risk, accepted for MVP.** An owner who loses their key or hostile-pauses a
market while betting is open still has no recovery path for bettors. This is a real,
known gap — not an oversight. Worth a v1.10 candidate if it matters in practice; the
fix already exists (see git history / this audit's prior revision) and can be
re-applied without re-deriving it.

### R-5 detail (build configuration, not a code defect)

The factory embeds the market's full creation bytecode, so the two contracts share one
EIP-170 budget. Measured across the actual build history:

| Build | Factory deployed size | Headroom |
|---|---|---|
| v1.3 (pre-fix baseline) | 24,252 | 324 |
| Optimizer off (any version) | 39,147 | **−14,571 — deployment fails** |
| v1.9/v1.4, optimizer on runs=200 | 24,523 | 53 |
| v1.9/v1.4, optimizer on runs=1 | 24,224 | 352 |
| **v1.9/v1.4, runs=1, R-4 removed (shipped)** | **24,153** | **423** |

Deploy at **runs=1**. The identifier fix plus PE-1 cost 200 bytes net of v1.3's baseline
(324 → the 24,224 runs=1 figure's 352 already reflects runs=1 alone; R-4's removal
recovered a further 71 bytes on top). Contract size remains a first-class constraint on
any future change to either file.

---

## Compilation verification

Both contracts were compiled with solc 0.8.20 against OpenZeppelin 4.9.3 as part of this
delta audit. One error was caught this way and would not have been caught by review:
`error InvalidIdentifier()` had been declared at file level in *both* contracts, and the
factory imports the market — a `DeclarationError: Identifier already declared` that
would have failed the Remix compile. Removed from the factory; it inherits the market's
declaration. Post-fix, both contracts compile clean with no errors.

---

## Live testnet proof (Sept 2, 2026)

The core claim of this delta — that `requestSettlement()` no longer reverts under v1.9
— was proven end-to-end against live infrastructure, not just reasoned about. Executed
manually via Remix rather than the originally-planned automation script (see
`v1.9-testnet-rehearsal.md` for why: three consecutive RPC-provider-consistency
failures — a solc contract-lookup bug, an allowance read-after-write race, and a nonce
assignment race, each independently root-caused and fixed in the script — made a
watched manual run the more reliable path given the time already invested).

**Sequence executed on Base Sepolia, every step independently verified by decoding raw
event log data rather than trusting UI summaries:**

1. Deployed `SportsbookFactory-v1_4-TESTNET.sol` (identical to the shipped v1.4 except
   `MIN_BOND` lowered from 100 USDC to 1 USDC, solely to fit the Sepolia faucet's
   10 USDC/day limit — this is the only difference from the mainnet build).
   Factory: `0x7f18417Ccf9D4772227A8cce132C48b0452E9786`.
2. Confirmed `ASSERT_TRUTH2` not yet whitelisted on Base **Sepolia**'s
   `IdentifierWhitelist` (`0x4da2fD75dd26A8C8A0a8Db892019651344705836`) — expected,
   since Sepolia has no DVM support and governance propagation lags mainnet. This does
   not affect the mainnet identifier decision (`ASSERT_TRUTH2`), already confirmed
   `true` against mainnet's real whitelist. Called `setSettlementIdentifier()` on the
   testnet factory with `ASSERT_TRUTH`'s value, confirmed via the `SettlementIdentifierUpdated`
   event decoded directly from the transaction log (`old: ASSERT_TRUTH2, new: ASSERT_TRUTH`).
3. Created market `NFL-2026-REHEARSAL-MANUAL`
   (`0x1ce7e684676a32c26748848fd0f6c613128f7a74`) — confirmed via the factory's
   `MarketCreated` event: correct creator, correct default spread bounds (±100),
   correct fee (200 bps), correct gameId, all decoded from raw log data.
4. Placed a 10 USDC bet — confirmed via `Transfer` events: 10.2 USDC pulled (stake +
   2% fee), 0.2 USDC fee swept back out, net 10 USDC stake in the pool. Fee math
   verified exactly against the documented 2%-upfront model.
5. Closed betting.
6. **Called `requestSettlement(7)` — the exact call that reverted under v1.8.1 on
   every deployed market. It succeeded.** Decoded directly from the `AssertionMade`
   event emitted by UMA's real `OptimisticOracleV3` on Base Sepolia
   (`0x0F7fC5E6482f096380db6158f978167b57388deE`): identifier used was `ASSERT_TRUTH`
   (confirmed from the event's own topic data, not inferred), and the full claim text
   UMA received was recovered byte-for-byte from the log: *"The final spread of game
   NFL-2026-REHEARSAL-MANUAL was 7 points. Positive = HOME team (first named in gameId)
   won by that margin. Negative = AWAY team (second named) won. Zero = tie."* The
   market's own `SettlementRequested`-equivalent event confirmed `assertionId`,
   `proposedSpread: 7`, and `proposer` matching the calling wallet exactly.
7. **After the ~2 hour liveness window cleared, called `executeSettlement()`.**
   Confirmed via UMA OOV3's own settlement event (referencing the market address
   directly) that the assertion resolved **TRUE**; the full 1 USDC testnet bond was
   returned to the caller; the market's own event confirmed `settled = true` and
   `finalSpread = 7`, matching the proposed value exactly.
8. **Called `claimPayout(0)` — the final step.** Decoded three independent sources, all
   in exact agreement: the ERC20 `Transfer` event (market → wallet, 10.0 USDC), the
   market's own claim-confirmation event (bettor + 10.0 USDC), and the directly-observed
   wallet balance delta (45.8 → 55.8 USDC, +10.0). Correct result for a single-bettor
   settled market with no opposing stake: full stake returned, no gain or loss.

**Full cycle complete. Every step that reverted under v1.8.1 now succeeds, live, on
real chain state — proven, not assumed.**

---

## What this delta does not cover

- **The two stranded v1.3-factory markets** (Titans/Seahawks, Lions/Commanders) are out of
  scope — they run v1.8.1 bytecode and cannot be upgraded in place. They are wound down via
  `triggerRefund()` after their 7-day window, unrelated to this fix.
- **No other contract logic changed.** Pool math, Z-line curve, fee model, payout
  calculation, and every other function are byte-for-byte identical to v1.8.1 aside from
  the two diffs above. This audit did not re-review C-1/C-2/C-3/H-1 through H-4 from prior
  rounds since nothing touching them changed.
- **A full Foundry/Hardhat regression suite was not run** as part of this delta (per the
  existing Remaining Known Issues note in `audit-april-2026.md`: "No Foundry test suite —
  Medium — Manual testing only"). The live testnet rehearsal above is the substitute for
  this release, and covers the one path that actually mattered (the C-1 fix), but is not
  a substitute for automated regression coverage of the rest of the contract.

---

## Auditors

Delta-audited by Claude (Anthropic), single round, against the actual `SportsbookMarket`
v1.8.1 and `SportsbookFactory` v1.3 source in the project repo (not from memory). Not a
formal third-party audit. Per the project's standing recommendation, a professional audit
is advised before significant value is at risk on mainnet — this recommendation is more
pointed than usual given this release exists specifically because a previous "audited and
shipped" contract had a runtime-only critical bug that five rounds missed.

---

*Delta audit completed: August 2026 — updated Sept 2, 2026 (R-4 removed, live testnet proof added)*
*Contract versions: SportsbookMarket v1.9, SportsbookFactory v1.4*
*Supersedes nothing — supplements `audit-april-2026.md` / `audit-june-2026.md`*
