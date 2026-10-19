# Bankr signing probe

Learn how a Bankr wallet signs a USDC `ReceiveWithAuthorization` before we write the
skill. Read-only plus one offline signature. **Moves no funds.**

## Run it (Jeff, locally)

```bash
cd integrations/bankr/probe
npm install
BANKR_API_KEY=bk_... node probe.mjs
```

Node 20+. The key needs `walletApiEnabled` and must not be read-only, or `/wallet/sign`
answers 403 (that is itself a useful result: paste it back). Optional `MARKET` (or `--market <address>`) picks the target market; see step 3. Optional `BASE_RPC_URL`
overrides the public RPC (`https://mainnet.base.org`); if you set it, nothing here prints it.

## What it does

1. `GET https://api.bankr.bot/wallet/me`, prints the Base (EVM) wallet address.
2. Reads that address's code on Base and classifies it: no code = plain EOA;
   `0xef0100…` = EIP-7702 delegated EOA (prints the delegate); anything else = contract wallet.
3. Picks a market the Factory v1.6 created. The authorization is expired and never submitted, so
   it does not need to be open. Order: your override (`MARKET=0x… ` or `--market 0x…`, accepted only
   if the factory's `gameIdByMarket` is non-empty), else the first open market, else the last
   market ever created. It prints which one it used and whether it is open. If the factory has
   created no markets at all it stops with a message.
4. Builds a `ReceiveWithAuthorization` (USDC domain on Base; from = the Bankr wallet; to = that
   market; value 1020000; nonce = `keccak256(abi.encode(salt, true))` with a random salt).
   **`validBefore` is hard-coded to 1 (1970)**, so USDC rejects the signature as expired
   and it can never be redeemed. The script asserts that twice and refuses to run otherwise.
5. `POST /wallet/sign` with `eth_signTypedData_v4`. On 403 it prints the body verbatim and stops.
6. Prints the signature length, which relay function that implies (65 bytes = `placeBetFor`,
   otherwise `placeBetForWithSignature`), the returned signer, and whether signer == wallet.
7. Verifies the signature: EOA = `ecrecover` against the EIP-712 digest; 7702 or contract wallet =
   `isValidSignature(digest, sig)` via `eth_call`, printing the returned magic value.

## What it never does

- Never calls Even Steven's `POST /api/bet`.
- Never calls `/wallet/submit`, `/wallet/transfer`, `/wallet/swap` or any Bankr write other than `/wallet/sign`.
- Never sends a transaction of any kind. The only chain access is `eth_getCode`, `getOpenMarkets` and `isValidSignature` reads.
- Never prints, logs or writes the API key. It is sent only as the `X-API-Key` header, and is
  redacted if a response ever echoes it. RPC error text has URLs stripped.
- No `ref`, no builder code, nothing else attached to the typed data.

## Paste back to the Integrations Lead

Everything between `--- paste this block back ---` and `--- end ---` (a small JSON object:
wallet, accountType, delegate, signatureBytes, relayFunction, signer, signerMatches, verified,
verifyNote). If the run stops on a 403 or any error, paste the printed output instead.
It contains no secret.

## Tests

```bash
npm test                    # unit tests: mocked Bankr API and RPC, throwaway key, no network
```

Fork test (Base mainnet fork, real Circle USDC, fork-only funded accounts, no keys):

```bash
cd ../../../scripts/fork-tests && npm install && npx hardhat node   # terminal 1 (needs ALCHEMY_RPC_URL, see its README)
cd ../../integrations/bankr/probe && node fork.test.mjs             # terminal 2
```

It deploys a v1.11 market and a minimal ERC-1271 mock wallet that returns the magic value only
for a valid inner ECDSA signature wrapped as `abi.encode(ownerIndex, sig)`, then relays the
wrapped (192-byte) signature through `placeBetForWithSignature`. It also checks that a stranger's
inner signature, a wrong `ownerIndex` and an unwrapped 65-byte signature are all rejected.
