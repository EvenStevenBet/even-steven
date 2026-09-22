# W3 — EIP-7702 under real Prague semantics

EIP-7702 activates at **Prague**. The main fork harness pins `hardfork: shanghai`,
matching the contracts' `evmVersion`, and there `0xef0100||delegate` is not a
delegation indicator — it is 23 bytes whose first byte is an invalid opcode. Any
call into such an account reverts, so USDC's `SignatureChecker` rejects the
signature. That produces the right-looking answer for the wrong reason.

hardhat 2.22.17's EDR supports up to `cancun`, so this directory pins its own
newer hardhat purely to get `prague`, and nothing else in the repo depends on it.

```bash
cd scripts/fork-tests/prague
npm install
npx hardhat node --hostname 127.0.0.1 --port 8547   # terminal 1
node w3.mjs                                          # terminal 2
```

It compiles the v1.11 contracts from `contracts/` at runs=200 (evmVersion shanghai,
as shipped) and runs them on a Prague fork — which is the realistic combination,
since Base is past Pectra.

**What it establishes**

* A 7702-delegated account whose delegate implements ERC-1271 can bet through
  **either** `placeBetFor` **or** `placeBetForWithSignature`.
* The same account with a delegate that does not answer `isValidSignature`
  usefully is rejected by USDC through **both** functions, with
  `Error("FiatTokenV2: invalid signature")`.

So the deciding factor is the delegate, not the entry point. The delegate carried
by hardhat's well-known default accounts on Base mainnet
(`0x8a67b5020ee254ef48e3b6a04927f39baf7e408a`) is of the second kind.
