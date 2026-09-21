# Fork tests — SportsbookMarket v1.10 vs v1.11

Differential and new-behaviour tests for Even Steven v3, run against a **pinned Base
mainnet fork** with the **real Circle USDC token** and the **real UMA OptimisticOracleV3**.

The previous generation of this harness lived in a scratch directory and was lost. This
one is committed. Keep it that way.

## What it proves

1. **Differential (D1–D9).** For each scenario a v1.10 deployment (the bytecode that is
   live on mainnet today) and a v1.11 deployment are created side by side, the *identical*
   call sequence is run against both, and everything is compared: every return value, every
   public getter, the whole `bets[]` array, all USDC balances, all logs and all revert data.
   Only four categories of difference are allowed:

   | | allowed difference |
   |---|---|
   | (i) | extra `BetClaimed` logs and one extra `SettlementDetails` log in v1.11 |
   | (ii) | pause-guarded calls revert `MarketPaused()` instead of `Error("Pausable: paused")` |
   | (iii) | non-owner calls revert `NotOwner()` instead of `Error("Ownable: caller is not the owner")` |
   | (iv) | gas |

   Anything else fails the run and prints a STOP line.

2. **New behaviour (N1–N15, E1–E3, C1a–C1d).** `claimPayoutFor`, the two additive events,
   and the C1 custom errors, asserted on exact balances, exact decoded event arguments and
   exact 4-byte revert selectors.

## Running it

```bash
cd scripts/fork-tests
npm install

# terminal 1 — the fork (reads ALCHEMY_RPC_URL from ../.env, never prints it)
npx hardhat node

# terminal 2
node run.mjs all            # everything
node run.mjs differential    # D1–D9 only
node run.mjs new             # N/E/C1 only
ONLY=D4,D8 node run.mjs differential   # selected differential sections
RUNS_B=200 node run.mjs all  # compile v1.11 at optimizer runs=200 (Stage 3)
```

Exit code is 0 only when there are no failures and no STOP conditions.

## Configuration

* `ALCHEMY_RPC_URL` — a Base **mainnet** RPC, read from `scripts/.env`, which is gitignored.
  It is never logged, and nothing in this harness can send a mainnet transaction: hardhat
  executes every transaction locally and only issues reads upstream.
* `FORK_BLOCK` — the pinned fork block (see `hardhat.config.cjs`). Bump it deliberately,
  never incidentally; every measurement in a report is only comparable within one pin.
* Compiler is pinned to **solc 0.8.20+commit.a1b79de6, optimizer on, runs=1, evmVersion
  shanghai**, and the run aborts if solc is anything else. Hardhat compiles nothing — the
  harness deploys the solc artifacts as raw bytecode, so the tested bytecode is exactly the
  measured bytecode.
* `allowUnlimitedContractSize` is **false**, so EIP-170 is enforced on the test chain.

## Two things that will bite you

**Never use hardhat's default accounts on a mainnet fork.** Their addresses are publicly
known and carry real Base state. At the pinned block every one of them holds an **EIP-7702
delegation** (`0xef0100…`), which makes them contracts as far as USDC's `SignatureChecker`
is concerned: every EIP-3009 signature then goes down the EIP-1271 path and is rejected
with `FiatTokenV2: invalid signature`, no matter how correct the signature is. `lib/chain.mjs`
generates fresh keys instead and `assertFreshActors()` proves each actor has no code.

**An EIP-3009 nonce is consumed per signer, not per market.** In a paired differential run
the two markets must be given authorizations signed over *different* salts, or the second
redemption fails on a nonce the first one already burnt. The resulting `AuthorizationUsed`
nonces are registered with `pair.addToken()` so the logs still compare byte for byte. The
same mechanism tokenises the UMA `assertionId`, which hashes the market address into itself
and therefore legitimately differs between the two deployments.

## Layout

```
run.mjs             entry point, banner, gas/Z tables, difference summary
differential.mjs    D1–D9
newbehaviour.mjs    N1–N15, E1–E3, C1a–C1d
lib/compile.mjs     solc 0.8.20 at the pinned settings; refuses any other compiler
lib/chain.mjs       viem clients, USDC minting via Circle's masterMinter, EIP-3009 signing,
                    paired same-block execution, raw eth_call for exact revert bytes
lib/deploy.mjs      deploys a version set and creates markets through the factory
lib/fixture.mjs     world/actor setup, paired market creation
lib/flow.mjs        close -> request -> real UMA liveness -> executeSettlement
lib/pair.mjs        the differential engine and the allowed-difference classifier
lib/state.mjs       full-state snapshots, address tokenisation, structural diffing
lib/report.mjs      PASS/FAIL accounting
```

## Funding USDC on the fork

Real Circle USDC is minted by impersonating the token's own `masterMinter`
(`configureMinter` then `mint`). No mock token is used anywhere; the token under test is
the deployed Circle contract at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## UMA settlement on the fork

`requestSettlement` posts the real minimum bond (500 USDC on Base mainnet) to the real
OOv3, then the suite advances past the 7,200-second liveness with `evm_increaseTime` and
calls `executeSettlement`, which settles against the real oracle. Markets are created with
the factory's `ASSERT_TRUTH2` identifier, the mainnet value.
