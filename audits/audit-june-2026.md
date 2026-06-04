# Security Audit — June 2026

Even Steven smart contracts (SportsbookMarket v1.8.1, SportsbookFactory v1.3) were audited in Round 5 in June 2026, covering two focused areas: the factory delta from v1.2 to v1.3, and a full re-read of the settlement path to confirm no unintended changes crept in during the v1.8.1 taker fee migration.

---

## Audit Process

One audit round was conducted using Claude Opus with structured security prompts. The audit was scoped to two areas:

1. **Factory delta** — changes from v1.2 to v1.3: conversion of all `require(condition, "string")` statements to custom errors, removal of `getMarketByGameId()`, and optimizer enablement.
2. **Settlement path re-read** — full review of `requestSettlement()`, `executeSettlement()`, `_settleMarket()`, and `_calculatePayout()` to confirm no unintended changes during the v1.8.1 taker fee modifications.

The factory delta audit included De Morgan verification of all authorization-check inversions, and the settlement review included an end-to-end solvency proof for both the settlement and refund paths.

---

## Findings Summary

### Round 5 (v1.7 → v1.8.1, taker fee model; v1.2 → v1.3 factory delta)

| ID | Severity | Title | Status |
|---|---|---|---|
| R5-1 | Low | CEI ordering in `placeBet()` — fee sweep after state mutations | Resolved — fee sweep is last statement, after all effects and event, within `nonReentrant` |
| R5-2 | Low | Owner USDC availability — fee on every `placeBet()` means USDC-rejecting owner bricks market | Resolved — NatSpec added documenting requirement; factory-created markets transfer ownership to creator |
| F-1 | Informational | `getOpenMarkets()`, `getUnsettledMarkets()`, `getRefundableMarkets()` — confirmed NOT removed | No action — all three view functions present and unchanged |
| F-2 | Low | `getMarketByGameId()` removed — safe on-chain but broke documented agent ABI | Resolved — README and AGENTS updated to `marketByGameId(gameId)` mapping getter |
| F-3 | Informational | Optimizer 200 runs exceeds EIP-170 bytecode limit for factory | Resolved — deployed at 50 runs, Basescan Exact Match verified |
| F-4 | Low | Stale factory header comments (version label, H-3 description, removed function list, completed TODOs) | Resolved — cleaned in Windsurf before deploy |
| S-1 | Medium | Documentation — cancellation no longer makes bettors whole; README/AGENTS said "100% refund, no fee" | Resolved — all public docs updated to reflect placement fee non-refundable on cancellation |
| S-2 | Low | Availability — fee transfer to `owner()` on every `placeBet()`; USDC-blacklisted or rejecting owner bricks betting for lifetime of market | Resolved — NatSpec added (R5-2); documented in AGENTS safety notes |
| S-3 | Informational | Bond floor `MIN_BOND = 100 USDC` may understate actual UMA minimum on mainnet (~500 USDC) | No code change — operational note documented; `getMinimumBond()` returns correct value on mainnet |
| X-1 | Operational | Factory embeds market bytecode at compile time — must compile factory against v1.8.1 `SportsbookMarket.sol` | Resolved — verified in deploy; Basescan Exact Match confirmed both factory and first market |
| X-2 | Low | `BetPlaced` event gained `fee` field (6 params) — old docs showed 5-param signature | Resolved — README and AGENTS updated with correct 6-field signature |
| PE-1 | Low | Carried — `claimPayout()`/`claimAllPayouts()` carry `whenNotPaused`; hostile pause could block fund recovery | Open — queued for v1.9 |

---

## Settlement Path — Clean

`requestSettlement()` and `executeSettlement()` are byte-for-byte identical to audited v1.7. No unintended changes.

`_settleMarket()` — the only delta is the intended removal of the settlement-time fee sweep block. Correct for the taker model: the fee is collected at placement, so settlement takes no haircut. The seed is returned to the owner and winners split 100% of stakes.

`_calculatePayout()` — the `fee` and `prizePool` deduction lines are removed. Winners split the full distributable (all stakes). Solvency verified: Σ(winner payouts) = distributable = Σ all stakes = contract balance after seed return. Payouts drain the contract to zero with no shortfall and no surplus. Refund-mode solvency holds identically: only stakes were ever retained, each bettor gets their stake back, total equals remaining balance.

---

## Taker Fee Model — Accounting Proof

Under v1.8.1, fee accounting is consistent end to end:

- `placeBet()` pulls `stake + fee`, sweeps `fee` to `owner()`, adds only `stake` to the pool. Contract balance increases by exactly `stake`. `totalPool` increases by exactly `stake`. ✓
- `_settleMarket()` returns `protocolSeedTotal` to owner. Remaining balance = Σ all stakes = `totalPool − protocolSeedTotal`. ✓
- `_calculatePayout()` returns `bet.stake × distributable / cachedWinningStakes` with no haircut. Σ winner payouts = distributable. ✓
- `cancelMarket()` / `triggerRefund()` return `protocolSeedTotal` to owner. Remaining balance = Σ all stakes. Each bettor claims `bet.stake`. Total refunds = Σ all stakes. ✓

Effective bettor friction: $100 stake + $2 fee = $102 out of pocket. Gross payout at liquidity = $200 (2× stake). Net profit = $98. Friction = $2 = **2.00% of stake**. This replaces the v1.7 settlement-model figure of 4.00% friction and is reflected in all public documentation.

---

## Factory Delta — Custom Error Verification

All `require(condition, "string")` → `if (!condition) revert CustomError()` conversions were verified for behavioral equivalence. The authorization check was explicitly verified for correct De Morgan inversion:

- Original: `require(msg.sender == owner() || operators[msg.sender], "Not authorized")`
- New: `if (msg.sender != owner() && !operators[msg.sender]) revert NotAuthorized()`
- De Morgan: `!(A || B)` = `(!A && !B)` ✓

All other conversions (constructor address checks, fee bounds, gameId, seed/approval transfers) were confirmed correct.

---

## Documentation Reconciliation

A documentation audit conducted alongside this round identified that all public-facing docs (README.md, AGENTS.md) described the v1.7 settlement-fee model (4% friction, $196 on $100, "settlement fee on total pool") rather than the v1.8.1 taker model. All docs were fully reconciled:

- Friction updated from 4.00% to 2.00% throughout
- Payout updated from ~$196 to ~$200 gross / ~$98 net
- Fee language updated from "settlement fee on total pool" to "flat 2% protocol fee on stake, charged at placement"
- Cancellation/refund language updated to reflect placement fee non-refundable (Option A)
- `BetPlaced` event signature updated to 6-field (added `fee`)
- `getMarketByGameId()` references updated to `marketByGameId()` mapping getter
- Competitive framing updated: overround and slippage framed as house-equivalent costs, not merely "hidden fees"

---

## Remaining Known Issues

| Item | Severity | Notes |
|---|---|---|
| PE-1 — `whenNotPaused` on claim functions | Low | `claimPayout()` and `claimAllPayouts()` carry `whenNotPaused`. A hostile pause could delay fund recovery. Queued for v1.9. |
| Factory view O(n) | Low | `getOpenMarkets()` etc. iterate all markets. Acceptable at launch volume. Paginate at 500+ markets. |
| No Foundry test suite | Medium | Manual testing and Sepolia validation only. A full test suite is recommended before significant value is at risk. |

---

## Auditors

Audited by Claude Opus (Anthropic) using structured security prompts. Round 5 of five total audit rounds (March–June 2026). Not a formal third-party audit. A professional audit from a dedicated smart contract security firm is recommended before significant value is at risk on mainnet.

---

*Audit completed: June 2026*
*Contract versions: SportsbookMarket v1.8.1, SportsbookFactory v1.3*
*Deploy tx: `0x2ec96b82ced224a4eefa68b7b75ae30f20bb1ec810c069d94efbeb00408f0d25`*
*Basescan verified: Exact Match — factory and first market*
