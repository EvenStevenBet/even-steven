# Checks before anything is signed

All of these are enforced in code (`preSignChecks` in scripts/even-steven.mjs) on the exact typed data that is sent to Bankr's `POST /wallet/sign`. Any failure aborts before the signing call, and each one has a failing unit test.

| Check | Rule |
|---|---|
| Domain | exactly `{ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 }`, no extra fields |
| Type | primary type exactly `ReceiveWithAuthorization`, and it is the only type present (never `TransferWithAuthorization`, `Permit` or an approval) |
| Recipient | `to` is a market for which Factory v1.6 (`0x5906370b9831728ec523b647137a1bbf0ab45390`) returns a non-empty `gameIdByMarket` |
| Value | `value == stake + stake * FEE_PERCENT / 10000`, with `FEE_PERCENT()` read from that market |
| Signer | `from` is the Bankr wallet from `GET /wallet/me` |
| Window | `validAfter` is 0; `validBefore` is now + 600 seconds |
| Nonce | `keccak256(abi.encode(salt, greaterThan))` with a fresh random 32-byte salt per bet; `greaterThan` true is the HOME side |
| Stake | at least 1 USDC; at most 25 USDC unless `ES_MAX_STAKE` is set |
| Encoding | every uint256 is sent to Bankr as a decimal string |

Also checked at confirm time, before signing: the market is still open, the fee still equals the fee the user was shown, and the Bankr wallet is the one the bet was prepared for.

After signing and before the relay: Bankr's returned signer equals the wallet (compared with `getAddress`, so case does not matter), and the signature recovers to the wallet over the EIP-712 digest (ecrecover for a 65-byte signature; `isValidSignature` for a contract wallet). A bad signature is stopped here so it cannot cost a relay strike.

The relay payload is `marketAddress, bettor, greaterThan, stake, validAfter, validBefore, nonce, salt, signature`. A 65-byte signature goes to `placeBetFor`; any other length goes to `placeBetForWithSignature` (the relay chooses).
