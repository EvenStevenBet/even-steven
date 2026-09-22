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

**Which delegate this tests**

The authoritative case is **MetaMask's own `EIP7702StatelessDeleGator`**, already
deployed on Base at `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` and present at the
pinned fork block, so only the delegating EOA is `hardhat_setCode`'d. The script
prints its `NAME()`, `VERSION()` and `DOMAIN_VERSION()` to prove which contract it
is talking to. Note the runtime bytecode is **not** byte-identical to the Ethereum
mainnet deployment at the same address — `__self`, `delegationManager` and
`entryPoint` are immutables baked into runtime code — which is why the Base copy is
the right one to test on a Base fork.

`MetaMask/delegation-framework`'s `_isValidSignature` is a plain
`ECDSA.recover(_hash, _signature) == address(this)` with no ERC-7739 replay-safe
wrapping and no nested EIP-712 envelope, so it validates a raw EIP-3009 digest as
USDC computes it. Its `onlyProxy` guard (`address(this) != __self`) passes under
7702 and only blocks calling the implementation directly.

The synthetic `Test7702Delegate.sol` is no longer deployed here — it validated the
same 65-byte ECDSA shape, so it duplicated the real delegate instead of adding
coverage. The genuinely different case, an ERC-1271 wallet whose envelope is not
65-byte ECDSA, is W2 in `../wallet-tests.mjs`.

**What it establishes**

* A 7702-delegated account using MetaMask's real delegate can bet through
  **either** `placeBetFor` **or** `placeBetForWithSignature`; `isValidSignature`
  called on the account returns the magic value `0x1626ba7e` for our digest.
* The same account with a delegate that does not answer `isValidSignature`
  usefully is rejected by USDC through **both** functions, with
  `Error("FiatTokenV2: invalid signature")`.

So the deciding factor is the delegate, not the entry point. The delegate carried
by hardhat's well-known default accounts on Base mainnet
(`0x8a67b5020ee254ef48e3b6a04927f39baf7e408a`) is of the second kind.
