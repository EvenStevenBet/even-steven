# Relay errors

Generated from `explainBetError` in scripts/even-steven.mjs; the source of truth for the relay is AGENTS.md. The script prints the line and the action; the agent relays them.

**Retry rule.** When told to retry, resend the identical request: same salt, nonce and signature. EIP-3009 nonces are single-use, so an identical retry can never place a second bet. After a submission (SubmissionFailed, SubmissionPending, SubmissionReverted, DuplicateSubmission) the relay refuses the same authorization for 5 minutes, so the script checks the chain first. A new authorization is signed only after the chain shows no bet **and** the old validBefore has passed, and only through a fresh prepare and a fresh user confirm.

| HTTP | error | Meaning | Action | Class |
|---|---|---|---|---|
| 429 | `RateLimited` | Too many requests from this IP. | Resend the identical request after 60 seconds. | Resend the identical request |
| 400 | `InvalidRequest` | The relay rejected the request (InvalidRequest). | Give up and report it. | Stop |
| 400 | `InvalidBettor` | The relay rejected the request (InvalidBettor). | Give up and report it. | Stop |
| 404 | `MarketNotFound` | The relay does not know this market. | Rediscover open markets with the markets command. | Stop |
| 409 | `UnsupportedMarket` | The relay only handles markets created by Factory v1.6. | Give up on this market. | Stop |
| 400 | `BadAuthorizationNonce` | The nonce did not match the salt and side. | Start over with a fresh prepare. | Start over (new prepare) |
| 400 | `BelowMinBet` | The stake is under 1 USDC. | Raise the stake and prepare again. | Start over (new prepare) |
| 400 | `AuthorizationExpired` | The authorization has expired. | Prepare and confirm again. | Start over (new prepare) |
| 429 | `TooManyFailedSubmissions` | Three recent submissions for this wallet or IP reverted, so the relay is refusing more. | Stop. This clears 24 hours after the latest failure. | Stop |
| 409 | `DuplicateSubmission` | This authorization was already sent in the last 5 minutes. | Do not re-sign. Check the chain for the bet. | Check the chain first, never re-sign |
| 503 | `LockServiceUnavailable` | The relay cannot take bets right now (its lock service is down). Nothing was submitted. | Resend the identical request later. | Resend the identical request |
| 409 | `BettingIsClosed` | Betting on this market has closed. | Give up on this market. | Stop |
| 409 | `MarketEnded` | This market is settled or canceled. | Give up on this market. | Stop |
| 409 | `MarketFull` | This market reached its 1,000-bet cap. | Give up on this market. | Stop |
| 409 | `MarketPaused` | The owner paused this market. | Resend the identical request later while the authorization is valid; otherwise give up. | Resend the identical request |
| 409 | `FeeTransferFailed` | This market cannot take bets (its owner cannot receive USDC). | Give up and report it. | Stop |
| 400 | `SimulationReverted` | The bet would revert (unknown). | Give up and report the error name. | Stop |
| 502 | `RpcError` | The relay could not reach the chain. Nothing was submitted. | Resend the identical request in a few seconds. | Resend the identical request |
| 503 | `RelayNotConfigured` | The relay is misconfigured. Nothing was submitted. | Resend the identical request later; give up if it persists. | Resend the identical request |
| 503 | `RelayUnderfunded` | The relay is low on gas money. Nothing was submitted. | Resend the identical request later while the authorization is valid. | Resend the identical request |
| 502 | `SubmissionFailed` | The relay could not send the transaction. | Check the chain; if no bet landed, resend the identical request after the 5-minute lock. | Check the chain first, never re-sign |
| 504 | `SubmissionPending` | The transaction was sent but not mined yet. | Do not re-sign. Check the chain for the bet. | Check the chain first, never re-sign |
| 502 | `SubmissionReverted` | The transaction reverted, usually because the market changed. Your authorization is still unused. | Check the chain; at most one identical retry after the 5-minute lock. | Check the chain first, never re-sign |
| 500 | `CustodyInvariantViolated` | The relay's receipt check failed. This should never happen. | Stop and report the transaction hash to evenstevenbet@gmail.com. | Stop |
| 500 | `InternalError` | Unexpected server error. | Check the chain for the bet, then resend the identical request. | Check the chain first, never re-sign |

`AuthorizationRejected` (HTTP 422) by reason:

| reason | Meaning | Action | Class |
|---|---|---|---|
| `InvalidSignature` | USDC refused the signature (InvalidSignature). | Prepare and confirm again. | Start over (new prepare) |
| `AuthorizationUsedOrCanceled` | USDC says this authorization was already used. | Check the chain; if no bet exists, prepare again with a fresh salt. | Check the chain first, never re-sign |
| `AuthorizationNotYetValid` | The authorization is not valid yet. | Resend the identical request shortly. | Resend the identical request |
| `AuthorizationExpired` | USDC refused the signature (AuthorizationExpired). | Prepare and confirm again. | Start over (new prepare) |
| `InsufficientUsdcBalance` | The wallet does not hold enough USDC for stake plus fee. | Fund the wallet with at least the total, then resend the identical request. | Resend the identical request |
| `AccountBlacklisted` | Circle has blacklisted an account on this transfer. | Give up. | Stop |
| `UsdcPaused` | USDC itself is paused. | Resend the identical request later. | Resend the identical request |
