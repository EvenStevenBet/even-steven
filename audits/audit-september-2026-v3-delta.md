# Even Steven — v3 Delta Audit (September 2026)

**Scope:** SportsbookMarket v1.11, MarketDeployer v1.1, SportsbookFactory v1.6
**Baseline:** SportsbookMarket v1.10, MarketDeployer v1.0, SportsbookFactory v1.5 (live on Base mainnet)
**Auditor:** Claude, reviewing Code's implementation and test evidence across Gates 1–4
**Not a formal third-party audit.** Same status as the March/April/August 2026 rounds this supersedes in scope but not in kind.
**Branch:** v3-claim-payout-for, HEAD at 1468ec9 at time of writing. Nothing pushed, nothing merged, no mainnet transaction sent.

---

## 1. Summary of changes

Five changes ship together as v1.11 / v1.1 / v1.6. All are additive; no existing function, error, or event was modified or removed.

| # | Change | Motivation |
|---|---|---|
| 1 | `claimPayoutFor(address bettor, uint256[] betIds)` | Closes R6-9: an agent that bets gaslessly via `placeBetFor` still needed ETH to claim. Permissionless, no signature — payout always goes to `bettor`, never `msg.sender`. |
| 2 | `placeBetForWithSignature(address bettor, bool greaterThan, uint256 stake, AuthorizationBytes auth)` | Extends gasless betting to signers whose signature isn't 65-byte ECDSA (ERC-1271 contract wallets, e.g. Coinbase Smart Wallet-style envelopes). `placeBetFor` is unchanged and remains the path for plain EOAs. |
| 3 | `MarketPaused()` / `NotOwner()` custom errors | Replace OpenZeppelin's `Pausable: paused` / `Ownable: caller is not the owner` require-strings with machine-readable selectors, on the market contract only. |
| 4 | `BetClaimed(address,uint256,uint256)` / `SettlementDetails(uint256,uint256)` events | Additive logging so a bettor's payout is reconstructable from events alone, without calling into the contract post-settlement. |
| 5 | Optimizer `runs` raised from 1 to 200 | The MarketDeployer split in v1.10 removed the bytecode-size pressure that justified runs=1; a repeat-call-weighted setting is now affordable and matches usage (markets are created once, bet/claimed against many times). |

**Explicitly deferred, not shipped:** mapping Circle's EIP-3009 revert strings to custom errors (C2). Reasoning recorded in the working thread: the relay layer (the future x402 endpoint) can do this mapping off-chain at zero bytecode cost and zero audit risk to an already-audited payment path; the strings are already documented in AGENTS.md.

---

## 2. Method

Every claim below is sourced to a specific gate, and every gate's headline numbers were independently reproduced by me, not taken on Code's report alone. Three verification layers were used throughout:

1. **Differential testing.** v1.10 (live, audited) and v1.11 (candidate) were deployed side by side on a pinned Base mainnet fork (block 51,588,000) and run through identical call sequences. Any behavioral difference had to fall into one of five pre-declared allowed categories (extra logs, the two custom-error swaps, gas, or the one genuinely new function) — anything else was a stop condition. None occurred outside the allowed set across 434 differential assertions.
2. **Mutation testing.** Four deliberate bugs were injected into `claimPayoutFor` and four into `placeBetForWithSignature`; every mutant was independently confirmed to turn a named test red, at the final shipping configuration (runs=200). This is what makes the "0 failures" results credible rather than a suite that would pass regardless of what the code did.
3. **Live rehearsal.** A complete lifecycle — deploy, bet via both new and old entry points, real UMA settlement (real 7,200s liveness, no fast-forward), relayed claim, and live negative-path probes — was run on Base Sepolia with real transactions, not just a fork.

Compiler: `solc 0.8.20+commit.a1b79de6`, optimizer enabled, `evmVersion=shanghai`, verified at every gate to be this exact commit (not a substituted 0.8.26 or similar).

---

## 3. Bytecode size

| Contract | v1.10 (live) | v1.11 @ runs=200 | Δ | EIP-170 headroom |
|---|---|---|---|---|
| SportsbookMarket | 16,254 | 18,270 | +2,016 | 6,306 bytes |
| MarketDeployer | 17,650 | 19,668 | +2,018 | **4,908 bytes** |
| SportsbookFactory | 8,048 | 8,085 | +37 | 16,491 bytes |

All three well under the 24,576-byte EIP-170 limit, zero compiler warnings at every measurement (Gates 1, 1b, 1c, 2b).

**The deployer is now the tightest contract.** It carries the market's full creation bytecode (an architectural fact confirmed by reading `MarketDeployer-v1_0.sol` directly — it does `new SportsbookMarket(...)`, not a separate deployment), so the market's size growth is inherited by the deployer one-for-one. Headroom has gone from 6,926 bytes on live v1.10 to 4,908 bytes — about 29% of the original margin spent. This is the number a future release should check first.

**One architectural consequence worth stating plainly:** because the deployer embeds the market's bytecode, all three contracts necessarily share one compiler configuration. There is no mechanism in this codebase to compile the market differently from the factory or deployer. This was confirmed by source inspection, not assumed.

---

## 4. `claimPayoutFor` — design and verification

**Design:** permissionless, no signature. Any address may submit the call; the payout (or refund) is transferred to `bettor` — the address recorded on each bet — and only to that address. The relay never custodies funds. Idempotency is the pre-existing `bet.claimed` flag, the same mechanism `claimPayout`/`claimAllPayouts`/`claimPayouts` already use.

**Why no signature is needed, and why this isn't a weaker version of `placeBetFor`'s pattern:** EIP-3009 authorizes USDC moving *from* a signer. A claim moves USDC *to* a fixed, on-chain-recorded address. There is nothing for the bettor to authorize that isn't already guaranteed by `bet.bettor` being immutable once set. A signed-claim design was prototyped and measured (Gate 1, "Variant B") at +2,783 bytes runtime versus the shipped design's +965 bytes at the time, with no corresponding security benefit — the destination is fixed either way. Rejected on cost/benefit grounds, not merely on complexity.

**Verified:**
- Happy path, batch claims, wrong-bettor (`NotYourBet`), zero-address bettor, double-claim in both orders, partial-batch (some ids already claimed directly, others not — the exact edge case named in the original scope brief), duplicate id within one batch, refund-mode claiming (both `cancelMarket()` and `triggerRefund()` paths), claiming while paused (PE-1 parity — deliberately not `whenNotPaused`), and the full gasless lifecycle (bet via `placeBetFor`, claim via `claimPayoutFor`, bettor holding zero ETH and sending zero transactions throughout) — all confirmed on the mainnet fork (Gate 2) and reconfirmed live on Base Sepolia with real UMA settlement (Gate 3).
- **Mutation-confirmed:** dropping the `bet.bettor != bettor` check (the theft case — anyone could name an arbitrary address and claim someone else's bet to it) was caught by N3 returning success where `NotYourBet` was expected. Dropping `bet.claimed = true` was caught, correctly, via `InsufficientBalance` rather than `AlreadyClaimed` — Code noted this is exactly the failure shape a missing idempotency guard should produce. Both mutants are unambiguous theft/double-spend scenarios, and both are caught.
- **Live on Sepolia:** the agent EOA and the ERC-1271 wallet contract (see §5) were each paid exactly 2× their stake by a relay that was neither payee, with the relay's own USDC balance unchanged, and both bettor-side keys still at 0 ETH / 0 transactions after the claim.

**Residual property, by design, not a defect:** anyone can trigger a bettor's claim at a time the bettor didn't choose. They cannot redirect or custody the funds. A bettor's own direct claim may revert `AlreadyClaimed` if a relay claimed first — the money has already landed in that case, which is a UX note for AGENTS.md, not a fund-safety issue.

---

## 5. `placeBetForWithSignature` — design and verification

**Design:** mirrors `placeBetFor`'s pre-flight checks exactly (nonce-derivation binding, zero-bettor check, fee calculation) but accepts the EIP-3009 signature as opaque `bytes` rather than decomposed `(v, r, s)`, and calls USDC's `receiveWithAuthorization(..., bytes signature)` overload instead of the `(..., uint8, bytes32, bytes32)` one. `placeBetFor` is untouched — confirmed byte-identical ABI entry and identical selector across both versions at every gate.

**Why this exists as a second function rather than a modified `placeBetFor`:** a 65-byte ECDSA signature cannot represent an arbitrary ERC-1271 wallet's signature format (confirmed: the tested Coinbase-Smart-Wallet-shaped envelope was 192 bytes). USDC's own `SignatureChecker` (read directly from Circle's `stablecoin-evm` source) branches on whether the signer address has code: no code → `ecrecover`; has code → call `isValidSignature` via ERC-1271. The new function is a thin pass-through to the second branch; it contains no signature-verification logic of its own.

**Scope clarification recorded mid-build:** this function was *not* built specifically for EIP-7702. It was built for any non-65-byte signature, and EIP-7702 turned out to be a special case of "signer has code" — not a separate mechanism requiring separate contract logic. This was confirmed, not assumed:

- MetaMask's actual deployed 7702 delegate (`EIP7702StatelessDeleGator`, `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, audited by Cyfrin) was read directly from source. Its `isValidSignature` does `ECDSA.recover(hash, signature) == address(this)` — plain 65-byte ECDSA, no replay-safe wrapping, no internal format restriction.
- **Consequence:** MetaMask 7702 users do not need `placeBetForWithSignature` at all — `placeBetFor` already covers them, confirmed by running both functions against the real deployed delegate bytecode on the Base mainnet fork (not a synthetic stand-in). Both succeeded identically.
- `placeBetForWithSignature` is therefore needed specifically for wallets whose signature genuinely cannot fit 65 bytes — the Coinbase-Smart-Wallet-shaped case is the concrete example tested.
- The general rule, stated for any wallet not explicitly tested: outcome depends on whether the signer's code (permanent contract wallet or 7702 delegate) implements ERC-1271 and accepts a raw digest. A delegate that only validates its own internal message format, or doesn't implement ERC-1271 at all, fails through both functions identically. This was demonstrated as a negative control: hardhat's well-known default-account delegate (unrelated to MetaMask) fails both `placeBetFor` and `placeBetForWithSignature` with the identical `FiatTokenV2: invalid signature` revert.

**Verified:**
- EOA via the bytes-signature variant produces logs and state identical to the same bet placed via `placeBetFor` (mainnet fork, Gate 2c).
- A minimal ERC-1271 test wallet with a 192-byte non-65-byte envelope: bet succeeds only through the new function (the same signature is unusable via `placeBetFor` — not expressible in `v,r,s`), and after settlement the wallet is paid exactly 2× stake via `claimPayoutFor`, with the wallet owner's key never funded and never used.
- MetaMask's real deployed 7702 delegate, both on the fork and confirmed by reading its source: both entry points succeed.
- Negative paths, largely byte-identical to `placeBetFor`'s: bad nonce, zero bettor, replay, expired, not-yet-valid, paused, betting closed, `MAX_BETS`. Two negatives have no `placeBetFor` counterpart because `v,r,s` cannot express them: empty or truncated signature, which surfaces Circle's own `ECRecover: invalid signature length` — not a Sportsbook custom error.
- **Mutation-confirmed** on the new function specifically: dropping the nonce-derivation check was caught by the side-flip case (a signed GREATER authorization succeeding when submitted as LESS — R6-2 confirmed load-bearing on this function too, not just inherited); dropping the zero-bettor check; recording the bet for `msg.sender` instead of `bettor` (caught via `BetPlaced.bettor` showing the relay, and via the resulting `claimPayoutFor` call reverting because the recorded bettor no longer matched); and passing `msg.sender` as `from` to USDC.
- **Live on Sepolia:** a real ERC-1271 wallet contract (deployed on Sepolia, funded with USDC only) placed a bet via `placeBetForWithSignature`, submitted by a relay, and was later paid via `claimPayoutFor` — the full three-bettor lifecycle (agent EOA + ERC-1271 wallet + owner) settled correctly at spread +11, with both winners paid exactly 2× stake.

**Deliberately out of scope:** mapping Circle's revert strings to custom errors on this path (C2, deferred — see §1). Coinbase Smart Wallet's EIP-5792 + Paymaster flow is a separate gasless mechanism entirely (account-abstraction-level gas sponsorship) and does not route through this function or depend on it.

---

## 6. `MarketPaused()` / `NotOwner()`

Two OpenZeppelin `require`-string reverts (`Pausable: paused`, `Ownable: caller is not the owner`) are replaced with custom errors on the **market contract only** — factory and deployer unchanged. Achieved via `_requireNotPaused()`/`_checkOwner()` overrides, at a net cost of −81 bytes.

**Verified:** exact selectors `0x54882d18` (`MarketPaused`) and `0x30cd7471` (`NotOwner`) confirmed on every guarded function (`placeBet`, `placeBetFor`, `placeBetForWithSignature`, `requestSettlement`, `executeSettlement`, `openMarket` for pause; `closeBetting`, `cancelMarket`, `pause`, `sweepUnclaimed`, `recoverStuckBond`, `openMarket`, `transferOwnership` for owner), on the mainnet fork and confirmed live on Sepolia. `unpause()` on an already-unpaused market deliberately still reverts with OZ's `Pausable: not paused` string — recorded, not a gap. Owner happy paths (pause/unpause/closeBetting/cancel) unaffected.

**Deliberately unmapped:** Circle's own require-strings for `placeBetFor`/`placeBetForWithSignature` failures (see §1, C2 deferral).

---

## 7. `BetClaimed` / `SettlementDetails`

Two additive events. `PayoutClaimed` and `MarketSettled` — the two events an indexer might already depend on — are confirmed byte-identical (topic0 unchanged) between v1.10 and v1.11 at every gate. All thirteen pre-existing market events are unchanged; only two are new.

`BetClaimed(bettor, betId, payout)` fires once per claimed bet on all four claim paths (`claimPayout`, `claimAllPayouts`, `claimPayouts`, `claimPayoutFor`); within a single transaction the `BetClaimed` payouts sum exactly to that transaction's `PayoutClaimed.amount` — confirmed as an explicit assertion, not just visually.

`SettlementDetails(distributable, winningStakes)` fires once, immediately before `MarketSettled` in the same transaction. `distributable == totalPool - protocolSeedTotal` and `winningStakes == cachedWinningStakes`, both cross-checked against live chain reads at the settlement block. Neither `cancelMarket()` nor `triggerRefund()` emits it, since neither path has a distributable pool to report.

**The property this exists to prove — event-only payout reconstruction — was independently tested**, not just asserted: using only `BetPlaced`, `MarketSettled`, and `SettlementDetails` (no other contract calls), a bettor's payout was computed via `payout = refundMode ? stake : (isWinner ? stake * distributable / winningStakes : 0)` and shown to equal the USDC actually received, to the base unit, in both seeded and seedless markets, on the fork (Gate 2c) and again live on Sepolia (Gate 3). This is the concrete capability AGENTS.md now documents for integrators.

---

## 8. Optimizer runs=200

Measured, not assumed: sizes and gas at runs 1/50/200/1000 (Gate 2b). Selected 200 as the point where per-call gas savings (roughly −0.5% to −1.1% on `placeBet`, `claimPayout`, `claimPayoutFor`) are realized at a size cost (+246 bytes on the market) that doesn't meaningfully compress the deployer's remaining headroom, while runs=1000's larger savings (~−0.6% to −1.15%) cost 5× the bytecode for a dollar-value difference too small to matter on Base gas prices. `createMarket` is the one operation that gets *more* expensive (+1.14%) — expected, since it's dominated by writing more optimizer-inlined creation code, and it happens once per market versus many bet/claim calls per market's life.

Full differential suite (434 assertions) was re-run with v1.11 at runs=200 against v1.10 at runs=1 (the true live-mainnet configuration) and produced the identical allowed-difference set as at runs=1 — no new behavioral difference introduced by the runs change itself.

---

## 9. Process findings — what went wrong during the build, and how it was caught

These are not contract defects. They're recorded because a credible audit should show its own verification could fail, not just that the contract passed.

- **Harness bugs that would have produced false positives, both caught before any result was reported:** an early viem `call()` was executing as an empty CREATE rather than an `eth_call`, which would have made every negative-path test vacuously pass; and error-wrapping was discarding raw revert bytes, causing a `null == null` false pass. Both were found and fixed in the same gate they were introduced, before results were shown.
- **Gate 2b's initial EIP-7702 claim was wrong and was corrected before shipping.** The first control used a `shanghai`-pinned test node, where `0xef0100...` is simply invalid opcode bytes, not a real delegation — the observed revert was real but for the wrong reason. This was caught, a genuine Prague-hardfork test environment was built, and the corrected finding (outcome depends on the delegate's own code, not on 7702 versus ERC-1271 as separate mechanisms) is what's recorded in §5 and in AGENTS.md. I flag this because the *first* answer given at Gate 2b was stated with confidence and was incomplete; it should not be taken as a model for how much verification a novel claim needs before being reported.
- **A live rehearsal key-loss incident, and why it didn't compromise the result.** During the Sepolia rehearsal, the process crashed after `requestSettlement` succeeded but before generated keys (agent, relay, wallet-owner) were persisted to disk, losing them with a live UMA assertion outstanding. Recovery was possible without those keys **because of the feature under test**: `executeSettlement` is callable by anyone, and `claimPayoutFor` is permissionless and always pays the bet's recorded bettor regardless of who submits the transaction. A fresh relay key completed the claim. This is recorded as a real-world demonstration of the claim's core property, not a workaround — but it does mean the rehearsal's claim-submission relay differs from its bet-placement relay, which is itself consistent with the design (any relay may submit) rather than a deviation from it.
- **A Sepolia public-RPC `getLogs` range limit** was hit and fixed (chunking into 1,000-block slices) during the final `verify` re-run — an operational fact worth carrying into the mainnet deploy plan, since mainnet RPC providers may impose similar or different limits and the deploy scripts should not assume an unbounded range query will succeed.

None of these findings implicate the shipped contract logic. All were caught by the verification process itself, before being reported as fact.

---

## 10. What was not changed, and what remains deferred

- `claimPayout`, `claimAllPayouts`, `claimPayouts`, `placeBet` — untouched, confirmed byte-identical ABI and selectors at every gate.
- `PayoutClaimed`, `MarketSettled`, and all eleven other pre-existing events — untouched, confirmed identical topic0.
- Factory and deployer ABIs — unchanged from v1.5/v1.0 respectively.
- Circle's EIP-3009 revert-string mapping (C2) — deferred to the relay layer, per §1.
- MAX_BETS removal, open market creation, `createMarketWithBoundsAndFee()`, predetermined close time, PRBMath/19:1 clamp changes, minimum pool size before settlement, factory view pagination, UMA sign-convention docs, operator authentication, R-4 (abandoned-market refund) — all out of scope for this release, as originally specified. R-4 in particular is confirmed absent from the live v1.10 source (contrary to an earlier stale project doc that claimed it was resolved) and remains an accepted, undeployed candidate.

---

## 11. Outstanding before mainnet

1. **This audit** — delivered here.
2. **Jeff's review of this audit and explicit go-ahead** — outstanding.
3. **Cutover execution at deploy time** (decided, not yet executed): `NEXT_PUBLIC_FACTORY_ADDRESS`, the bot's `.env`, and the three remaining stale Web App references (`.env.example`, `how-it-works` hardcoded addresses, `BUILD-SPEC.md`) all update as part of the mainnet rollout sequence, not before it. Verified on-chain that zero markets are open under Factory v1.5 and that every bet on the one existing v1.5 market has either been claimed or is an unclaimed loser owed nothing — so no market or claimable balance is orphaned by the cutover.
4. **Deployer headroom (4,908 bytes)** is the binding constraint for any future addition to this contract family; noted for whoever picks up the next release.

No mainnet transaction has been sent at any point in this build. Branch `v3-claim-payout-for` remains local, unpushed, unmerged.
