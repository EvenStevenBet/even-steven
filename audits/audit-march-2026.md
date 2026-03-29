# Security Audit — March 2026

Even Steven smart contracts (SportsbookMarket v1.7, SportsbookFactory v1.2) were audited across three rounds in March 2026.

---

## Audit Process

Three full audit rounds were conducted using Claude Opus with structured security prompts. Each round focused on incremental changes from the previous version. All findings were addressed before progression to the next round.

---

## Findings Summary

### Round 1 (v1.5 → v1.6)

| ID | Severity | Title | Status |
|---|---|---|---|
| C-1 | Critical | UMA default currency mismatch — bricked settlement | Resolved |
| C-2 | Critical | O(n) settlement DOS via unbounded bet array | Resolved |
| C-3 | Critical | ln() accuracy degrades at extreme pool ratios | Resolved |
| H-1 | High | currentZ not clamped to Z_MIN/Z_MAX | Resolved |
| H-2 | High | Owner settle() god mode — bypasses UMA | Resolved |
| H-3 | High | Factory transferFrom return value unchecked | Resolved |
| H-4 | High | 5% fee applied to canceled market refunds | Resolved |
| M-6 | Medium | cancelMarket() claim window edge case | Resolved |
| L-3 | Low | finalSpread not indexed in MarketSettled event | Resolved |
| L-4 | Low | assertionActive not reset on cancel/triggerRefund | Resolved |
| L-5 | Low | recoverStuckBond behavior post-settlement undocumented | Resolved |

### Round 2 (v1.6 → v1.7, configurable fee + getMarketEV)

| ID | Severity | Title | Status |
|---|---|---|---|
| NEW-1 | High | Factory leaves type(uint256).max approval dangling to every market | Resolved |
| NEW-2 | Medium | Factory approve() return value unchecked | Resolved |
| Carried | Medium | getMarketEV() maxEfficientPayout misleading on minority side | Resolved — renamed to balancedPayout with corrected NatSpec |
| Low | Low | Factory setDefaultFee NatSpec missing MIN_FEE mention | Resolved |
| Low | Low | Unwrapped zero-approve not documented | Resolved — intentional, commented |

### Round 3 (fee floor, settle() removal, bond fix, UMA fix)

| ID | Severity | Title | Status |
|---|---|---|---|
| — | — | settle() removal safety analysis | Confirmed safe — removed |
| — | — | 1 USDC fallback bond griefing vector | Resolved — MIN_BOND = 100 USDC |
| — | — | C-1 UMA currency fix implementation | Resolved — assertTruth() with explicit USDC |
| Low | Low | Fee floor allows zero-fee markets | Resolved — 0.2% minimum enforced |

---

## Resolution Details

**C-1 (Critical) — UMA Currency Mismatch**
Switched from `assertTruthWithDefaults()` to `assertTruth()` with explicit `usdc` currency parameter. No longer dependent on `oo.defaultCurrency()` matching Circle USDC. Works on any network regardless of UMA admin configuration.

**C-2 (Critical) — Settlement DOS**
`MAX_BETS = 1000` cap prevents the settlement loop from exceeding Base's 30M block gas limit. At 1,000 bets, settlement costs approximately 6.3M gas — well within limits. V2 roadmap includes O(log n) replacement via sorted cumulative stake structure.

**C-3 (Critical) — ln() Accuracy**
Pool ratio clamped to 19:1 before atanh series calculation. Above 19:1, the 5-term series exceeds 3% error. Clamp keeps error below 0.1% while preserving Z movement direction.

**H-2 (High) — Owner God Mode**
`settle()` removed entirely in v1.7. Settlement paths: UMA `requestSettlement()` + `executeSettlement()`, or `triggerRefund()` after 7 days. No owner override possible. Fully trustless.

**NEW-1 (High) — Dangling Approval**
Factory resets approval to 0 after `openMarket()` pulls seed. Prevents any deployed market from draining accidental factory USDC deposits. Zero-approve intentionally unwrapped — if it fails, market still deploys correctly with a harmless dangling approval rather than reverting an otherwise successful creation.

---

## Remaining Known Issues

| Item | Severity | Notes |
|---|---|---|
| Remix HTTP imports | Low | Blocks Hardhat/Foundry. Replace with npm before mainnet. |
| Factory view O(n) | Low | Acceptable at launch volume. Paginate at 500+ markets. |
| MIN_BOND testnet value | Info | Set to 1 USDC on testnet. Restore to 100 USDC for mainnet. |
| No Foundry test suite | Medium | Manual testing only. Full test suite before mainnet. |

---

## Auditors

Audited by Claude Opus (Anthropic) using structured security prompts across three rounds. Not a formal third-party audit. A professional audit from a dedicated smart contract security firm is recommended before significant value is at risk on mainnet.

---

*Audit completed: March 2026*
*Contract version: SportsbookMarket v1.7, SportsbookFactory v1.2*
