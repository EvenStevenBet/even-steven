# Even Steven — Agent & Developer Integration Guide

This document covers everything needed to programmatically interact with Even Steven markets. No UI required.

Even Steven is a houseless parimutuel sports betting protocol on Base. No house, no spread, no vig. Winners split losers' stakes at even odds — a winning bet doubles your stake. Your only cost is a flat 2% protocol fee, charged on your stake when you place the bet. That 2% is your total friction.

## Why this matters for an agent

An agent's job is to make money. Even Steven helps it make more, structurally — not through a promotion, but through the shape of the product.

Traditional spread betting is -110 on both sides: you lay $110 to win $100, and the $10 is the house's before the game even starts. A favorite might be -150 — lay $150 to win $100. Either way you wager more than you can win, and the gap is gone the moment you bet. Even Steven is true even money: $100 to win $100, minus a flat 2% fee. That is lower friction than every order-book venue (2% total versus ~4.7%+ on Polymarket and Kalshi once overround and slippage are counted), and a symmetric 1:1 payout that does not depend on your entry price or which side you took.

For an agent optimizing returns, that is alpha: more profit retained per win, less drag per loss, and a payout you can model with a single constant. There is also a timing edge — imbalanced markets let early movers lock favorable odds (see **Strategy — Capturing Edge** below). The rest of this guide is how to capture all of it.

---

## Quick Start

```javascript
// 1. Find open markets
const markets = await factory.getOpenMarkets();

// 2. Evaluate a market (payouts are gross of the 2% placement fee)
const [gameId, z, gPool, lePool, tPool, isOpen] = await market.getMarketState();
const [currentPayout, liquidPayout, impliedVig] = await market.getMarketEV(stake, greaterThan);

// 3. Approve and bet (the contract pulls stake + 2% fee)
await usdc.approve(marketAddress, ethers.MaxUint256);
await market.placeBet(greaterThan, stake);

// 4. Claim after settlement
await market.claimAllPayouts();
```

---

## HTTP Agent API (x402)

For agents that would rather not run their own RPC client, Even Steven also exposes read-only
market data over plain HTTP at `evensteven.bet`, monetized per-request via the
[x402](https://x402.org) protocol (HTTP `402 Payment Required`). No API key, no account —
pay per call in USDC on Base.

**These endpoints are read/quote only.** Placing a bet over HTTP is a separate, free endpoint —
see **Placing a bet via the relay (POST /api/bet)** below.

### Payment flow

1. Agent calls a protected endpoint with no payment.
2. Server responds `402 Payment Required` with payment terms (price, network, recipient) in
   the response body, per the x402 spec.
3. Agent's x402 client signs a USDC payment authorization and retries the request with an
   `X-PAYMENT` header.
4. Server verifies and settles the payment against the facilitator, then returns the data.

The easiest way to consume these endpoints is `x402-fetch`:

```javascript
import { wrapFetchWithPayment } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: base, transport: http() });
const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

const res = await fetchWithPayment('https://evensteven.bet/api/markets/agent');
const data = await res.json();
```

Install with `npm install x402-fetch`.

Even Steven's mainnet endpoints settle through the Coinbase CDP facilitator. Agents running
their own x402 client are not required to use CDP — any compatible facilitator on Base works,
since payment verification is against the on-chain USDC transfer, not a specific facilitator.

### Endpoints

| Endpoint | Price | Purpose |
|---|---|---|
| `GET /api/markets/agent` | $0.05 | Live on-chain snapshot of all open markets, enriched with EV for a 100 USDC reference stake on both sides |
| `GET /api/bet/quote` | $0.01 | EV quote for a specific gameId/side/stake, including fee and total cost |
| `GET /api/bet/status` | $0.01 | Bet positions for a given bettor address on a given market |

`ev.home`/`ev.away` in both endpoints below are computed server-side with the seed-corrected
formula, reading each market's own `protocolSeedTotal` — they are accurate as returned, no
client-side adjustment needed. They match `getMarketEV`/`simulatePayout` called directly on any
current market (SportsbookMarket v1.10 or later); only v1.9 and earlier markets under-quote — see
the note under **Pre-Bet Evaluation**.

**`GET /api/markets/agent`** — no query params. Always fresh (no cache).

```json
{
  "markets": [
    {
      "marketAddress": "0x...",
      "gameId": "NFL-2026-09-07-HOME-Chiefs-AWAY-Ravens",
      "currentZ": "-35000",
      "currentZDisplay": "-3.5",
      "greaterPool": "104000000",
      "lessEqualPool": "98000000",
      "totalPool": "204000000",
      "isOpen": true,
      "isSettled": false,
      "ev": {
        "referenceStake": "100000000",
        "home": { "currentPayout": "...", "liquidPayout": "...", "impliedVig": "200" },
        "away": { "currentPayout": "...", "liquidPayout": "...", "impliedVig": "200" }
      }
    }
  ],
  "relay": {
    "note": "Place bets via POST /api/bet — see AGENTS.md for the full relay guide.",
    "quoteEndpoint": "GET /api/bet/quote",
    "statusEndpoint": "GET /api/bet/status"
  },
  "timestamp": 1757262000000
}
```

If a single market's on-chain read fails, it appears in `markets` with an `error` field instead
of failing the whole response.

**`GET /api/bet/quote?gameId=<gameId>&side=home|away&stake=<decimal USDC>`**

```json
{
  "marketAddress": "0x...",
  "gameId": "NFL-2026-09-07-HOME-Chiefs-AWAY-Ravens",
  "side": "home",
  "greaterThan": true,
  "stake": "100000000",
  "fee": "2000000",
  "totalCost": "102000000",
  "currentZ": "-35000",
  "currentZDisplay": "-3.5",
  "ev": {
    "currentPayout": "...",
    "liquidPayout": "...",
    "impliedVig": "200",
    "netProfitAtLiquidity": "..."
  },
  "note": "To place this bet, sign an EIP-3009 ReceiveWithAuthorization for totalCost (to = marketAddress) and POST it to /api/bet."
}
```

`fee` and `totalCost` are computed at 200 bps. The market's own `FEE_PERCENT()` is authoritative
— read it before signing.

Errors: `400` missing/invalid `gameId`/`side`/`stake` (stake must be ≥ 1 USDC), `404` no market
for that `gameId`, `409` market found but not open for betting.

**`GET /api/bet/status?marketAddress=<address>&bettor=<address>`**

Both params required — reads `getBetsByAddress` / `getBet` directly (no log indexing).

```json
{
  "marketAddress": "0x...",
  "bettor": "0x...",
  "bets": [
    {
      "betId": "0",
      "side": "home",
      "greaterThan": true,
      "stake": "100000000",
      "lockedZ": "-35000",
      "lockedZDisplay": "-3.5",
      "claimed": false
    }
  ]
}
```

Errors: `400` if `marketAddress` or `bettor` is missing or not a valid address.

---

## Placing a bet via the relay (POST /api/bet)

`POST https://evensteven.bet/api/bet` places a bet that **you** own without anyone ever
holding your money. You sign an EIP-3009 `ReceiveWithAuthorization` for your USDC. Even
Steven's relay submits it to the market's `placeBetFor` (or `placeBetForWithSignature`) and
pays the ETH gas. USDC moves directly from your wallet to the market contract — the relay
never sends or receives your USDC — and the contract records **you** as the bettor, so the
payout can only ever go to you.

- **No x402 fee.** The endpoint is free and takes no `X-PAYMENT` header.
- **You need USDC, not ETH.** The relay pays the gas.
- **The contract charges the taker fee at placement:** `fee = stake × FEE_PERCENT() / 10000`,
  read from the market (200 = 2% on current markets). Your authorization's `value` must be
  exactly `stake + fee`. The stake enters the pool; the fee is swept to the market owner in
  the same transaction.
- **Supported markets:** only markets created by SportsbookFactory v1.6
  (`0x5906370b9831728ec523b647137a1bbf0ab45390`, SportsbookMarket v1.11). Any other market
  returns `409 UnsupportedMarket`.

### Step by step

1. **Quote.** `GET /api/bet/quote?gameId=…&side=home|away&stake=<decimal USDC>` ($0.01 over
   x402, see above) returns `marketAddress`, `greaterThan`, `stake` in base units, `fee` and
   `totalCost`. `totalCost` is the `value` you sign. The quote computes the fee at 200 bps;
   `FEE_PERCENT()` on the market is authoritative, so read it before signing, as the example
   below does.
2. **Sign** a `ReceiveWithAuthorization` for `value = stake + fee`, with `to` = the market.
3. **POST** the request body below.
4. **Handle** the 200 response, or act on the error table.

The route checks everything it can before submitting — request shape, market, nonce, stake,
expiry — then simulates the exact contract call from the relay. Nothing is sent on-chain
unless the simulation passes, so every error up to and including the 422s costs you nothing.

### EIP-712 domain and type

```
domain: { name: "USD Coin", version: "2", chainId: 8453,
          verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 }   // USDC on Base

ReceiveWithAuthorization(address from, address to, uint256 value,
                         uint256 validAfter, uint256 validBefore, bytes32 nonce)
```

- `from` = your address, the same as `bettor` in the request.
- `to` = the **market address** — not the relay, not the USDC contract.
- `value` = `stake + fee`.

Sign **`ReceiveWithAuthorization`, not `TransferWithAuthorization`** (the type x402
payments use). USDC only lets the payee — the market — redeem a `receiveWithAuthorization`,
so nobody who sees your signature can redeem it any other way. The domain above matches
USDC's on-chain `DOMAIN_SEPARATOR()`.

### Request body

All integers are decimal strings, so they survive JSON without precision loss. A real,
correctly signed example — from a throwaway wallet; its `validBefore` has lapsed, so it is
not reusable:

```json
{
  "marketAddress": "0xF0F11bbce394Cf780a20f8A7F63490F50a175A26",
  "bettor": "0xe44c8b0D235967E4A52BaCA6f93329C79056DaB4",
  "greaterThan": true,
  "stake": "1000000",
  "validAfter": "0",
  "validBefore": "1790389563",
  "nonce": "0xe42c9a46ec40b397fa95c067387e33a3fa82d960ee6582b3edc119025ed49b94",
  "salt": "0x36efdbca1204428f1623f12acef34e2a1eea03d24c2e092732b1c0e173568bed",
  "signature": "0xdf91e58c992ec349bf27b54735278a751abc96776b7bf9e702098a6c956b37c36dfa77a195fed7bd425f51e6dcae8040dee83b030aac7d3fa3044994bd9274b81b"
}
```

| Field | Type | Meaning |
|---|---|---|
| `marketAddress` | address | The market. Send **exactly one** of `marketAddress` or `gameId`. |
| `gameId` | string | Alternative to `marketAddress`, resolved through the v1.6 factory's `marketByGameId`. |
| `bettor` | address | The signer (`from`). Recorded as the bet's owner; the payout goes here. |
| `greaterThan` | boolean | `true` backs HOME: wins if `finalSpread × 10000 > lockedZ`. `false` backs AWAY: wins if `finalSpread × 10000 ≤ lockedZ`. |
| `stake` | decimal string | Stake in USDC base units (6 decimals), **excluding** the fee. Minimum `"1000000"` (1 USDC). |
| `validAfter` | decimal string | Unix seconds. The authorization cannot be used before this. `"0"` means immediately. |
| `validBefore` | decimal string | Unix seconds. The authorization expires at this time. Must be more than 30 seconds in the future when the request arrives; about 10 minutes is a sensible window. |
| `salt` | bytes32 hex | 32 random bytes you choose. Fresh for every bet. |
| `nonce` | bytes32 hex | `keccak256(abi.encode(salt, greaterThan))`. This is the EIP-3009 nonce you sign. |
| `signature` | hex bytes | Your EIP-712 signature: 65 bytes (`r‖s‖v`) from an EOA, or whatever your smart-contract wallet produces. |

**Why the nonce is derived, not random.** The signature covers `from`, `to`, `value`,
`validAfter`, `validBefore` and `nonce` — but not which side you are betting. With a random
nonce, whoever submits your authorization could place it on the other side of the line.
Deriving `nonce = keccak256(abi.encode(salt, greaterThan))` makes your signature a
commitment to one side. The market recomputes it from `salt` and `greaterThan` and reverts
`BadAuthorizationNonce()` on a mismatch; the route checks the same thing first and returns
`400 BadAuthorizationNonce` with the `expectedNonce`.

**`salt` must be unique across all your bets**, not just per market. USDC tracks spent
nonces per signer across the whole token, so reusing a salt on the same side of any market
produces a nonce USDC has already seen, and the bet is rejected
(`AuthorizationUsedOrCanceled`).

### Signature paths

The route picks the contract function from the signature's length:

| Signature | Contract call | Typical signer |
|---|---|---|
| Exactly 65 bytes | `placeBetFor` — split into `v, r, s` (a `v` of 0/1 becomes 27/28) | EOAs, including EIP-7702-upgraded EOAs such as MetaMask |
| Any other length | `placeBetForWithSignature` — passed through as opaque `bytes` | Smart-contract wallets verified through ERC-1271, e.g. Coinbase Smart Wallet-style envelopes |

USDC verifies the signature in both cases. See **Which bet function your wallet needs**
below for wallet compatibility.

### Runnable example (viem)

```javascript
// npm install viem
// AGENT_PRIVATE_KEY=0x... node bet.mjs
import { createPublicClient, http, parseAbi, encodeAbiParameters, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { randomBytes } from 'crypto'

const MARKET = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26' // marketAddress from GET /api/bet/quote
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const greaterThan = true   // true = HOME side, false = AWAY side
const stake = 1_000_000n   // 1 USDC (6 decimals); minimum is 1 USDC

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY)
const client = createPublicClient({ chain: base, transport: http() })

// The fee is set per market at creation. Read it; never hardcode it.
const feePercent = await client.readContract({
  address: MARKET,
  abi: parseAbi(['function FEE_PERCENT() view returns (uint256)']),
  functionName: 'FEE_PERCENT',
})
const fee = (stake * feePercent) / 10_000n
const value = stake + fee // the authorization covers stake + fee

// Bind the authorization to one side of the line.
const salt = toHex(randomBytes(32)) // fresh for every bet
const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))

const validAfter = 0n
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600) // 10 minutes

const signature = await account.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: { from: account.address, to: MARKET, value, validAfter, validBefore, nonce },
})

const res = await fetch('https://evensteven.bet/api/bet', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    marketAddress: MARKET,
    bettor: account.address,
    greaterThan,
    stake: stake.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
    salt,
    signature,
  }),
})
console.log(res.status, JSON.stringify(await res.json(), null, 2))
```

Run with a wallet that holds at least `stake + fee` in USDC, this places a real bet.

### Success response (200)

The first mainnet bet placed through the relay
([tx](https://basescan.org/tx/0xc159a488116d8206669897140c5079b54040d460bdb2c4c1e9a6c3be5a958f87)):

```json
{
  "success": true,
  "betId": "0",
  "bettor": "0x1164a458a716289c3d724fd1b3A8F5072593271e",
  "relay": "0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed",
  "marketAddress": "0xF0F11bbce394Cf780a20f8A7F63490F50a175A26",
  "gameId": "NFL-2026-09-27-HOME-Dolphins-AWAY-Chiefs",
  "greaterThan": true,
  "stake": "1000000",
  "fee": "20000",
  "lockedZ": "0",
  "lockedZDisplay": "0",
  "txHash": "0xc159a488116d8206669897140c5079b54040d460bdb2c4c1e9a6c3be5a958f87",
  "blockNumber": "51794070"
}
```

- All integers are decimal strings.
- `lockedZ` is the line your bet locked, in 4-decimal fixed point; `lockedZDisplay` is the
  readable form.
- `fee` is the taker fee actually charged.
- `relay` is the address that submitted the transaction and paid its gas.

The route answers only after the transaction is mined and it has checked the receipt: there
must be exactly one `BetPlaced` event, its bettor must be you, and no USDC may have moved to
or from the relay. Look the bet up later with
`GET /api/bet/status?marketAddress=…&bettor=…`.

### Errors

Every error body is JSON: `{ "error": "<Code>", "message": "…", …details }`.

**Retry rule: resend the identical request.** When the table says to retry, send the same
body again — same `salt`, `nonce` and `signature`. EIP-3009 nonces are single-use, so an
identical retry can never place a second bet: if the first attempt did land, the retry is
rejected with `AuthorizationUsedOrCanceled`. Sign a new authorization (new `salt`) only
after `GET /api/bet/status` confirms no bet was placed.

| Status | `error` | Meaning | What to do |
|---|---|---|---|
| 400 | `InvalidRequest` | A field is missing or malformed. `field` names it; "exactly one of `marketAddress` or `gameId`" reports `field: "marketAddress"`. | Fix the request. |
| 400 | `InvalidBettor` | `bettor` is the zero address. | Fix the request. |
| 404 | `MarketNotFound` | No contract at `marketAddress`, or no v1.6 market for `gameId`. | Give up on this market; rediscover open markets. |
| 409 | `UnsupportedMarket` | The market exists but was not created by SportsbookFactory v1.6. | Give up via the relay. A v1.10 market can still be bet directly (`placeBetFor` or `placeBet`). |
| 400 | `BadAuthorizationNonce` | `nonce` ≠ `keccak256(abi.encode(salt, greaterThan))`. `expectedNonce` is included. | Re-sign with the derived nonce. |
| 400 | `BelowMinBet` | `stake` is under 1 USDC. | Raise the stake and re-sign. |
| 400 | `AuthorizationExpired` | `validBefore` is not more than 30 seconds in the future. `validBefore` and `now` are included. | Re-sign with a later `validBefore`. |
| 409 | `BettingIsClosed` | Betting on this market has closed. | Give up. |
| 409 | `MarketEnded` | The market is settled or canceled. | Give up. |
| 409 | `MarketFull` | The market hit its 1,000-bet cap. | Give up. |
| 409 | `MarketPaused` | The owner has paused the market. | Retry later while `validBefore` allows; otherwise give up. |
| 409 | `FeeTransferFailed` | The market's owner cannot receive USDC, so the market cannot take bets. | Give up. |
| 422 | `AuthorizationRejected` | USDC refused the authorization. See `reason` below; `expected` holds the exact typed data the market expects you to have signed. | Depends on `reason`. |
| 400 | `SimulationReverted` | Any other revert. `errorName` or `reason` is included. | Give up and report the `errorName`. |
| 502 | `RpcError` | The server could not simulate the call against the chain. | Retry after a few seconds. |
| 503 | `RelayNotConfigured` | Server misconfiguration. Nothing was submitted. | Retry later; give up if it persists. |
| 503 | `RelayUnderfunded` | The relay's ETH is below its safety threshold. Nothing was submitted. | Retry later while `validBefore` allows. |
| 502 | `SubmissionFailed` | The transaction could not be sent. | Retry. |
| 504 | `SubmissionPending` | Sent, but not mined within 15 seconds. `txHash` is included. | **Do not re-sign.** Check `txHash` or `GET /api/bet/status`. If the transaction never lands, retry. |
| 502 | `SubmissionReverted` | Mined but reverted — usually the market changed between simulation and inclusion (for example, betting closed). `txHash` is included. The revert rolled back your authorization, so it is still unused. | Retry once; a 409 on the retry means give up. |
| 500 | `CustodyInvariantViolated` | The receipt did not match your bet. Should never happen. `txHash` is included. | Stop and report the `txHash`. |
| 500 | `InternalError` | Unexpected server error. | Check `GET /api/bet/status`, then retry. |

`AuthorizationRejected` reasons:

| `reason` | USDC revert | What to do |
|---|---|---|
| `InvalidSignature` | `FiatTokenV2: invalid signature`, or `ECRecover: invalid signature…` for a malformed one | What you signed differs from what the market redeems. Compare with `expected`. The usual causes: signing `TransferWithAuthorization`, `to` not set to the market, `value` = stake without the fee, or a wrong domain. Re-sign. |
| `AuthorizationUsedOrCanceled` | `FiatTokenV2: authorization is used or canceled` | The nonce is spent. Either this bet already landed (check `GET /api/bet/status`) or you reused a `salt`. If no bet exists, re-sign with a fresh `salt`. |
| `AuthorizationNotYetValid` | `FiatTokenV2: authorization is not yet valid` | `validAfter` is in the future. Retry after it passes. |
| `AuthorizationExpired` | `FiatTokenV2: authorization is expired` | Re-sign with a new window. |
| `InsufficientUsdcBalance` | `ERC20: transfer amount exceeds balance` | Fund the bettor with at least `stake + fee`, then retry. |
| `AccountBlacklisted` | `Blacklistable: account is blacklisted` | Give up. |
| `UsdcPaused` | `Pausable: paused` (USDC itself is paused) | Retry later. |

A real `422`, from the example request above sent by a wallet with no USDC:

```json
{
  "error": "AuthorizationRejected",
  "message": "USDC rejected the authorization: ERC20: transfer amount exceeds balance",
  "reason": "InsufficientUsdcBalance",
  "usdcRevert": "ERC20: transfer amount exceeds balance",
  "expected": {
    "primaryType": "ReceiveWithAuthorization",
    "domain": {
      "name": "USD Coin",
      "version": "2",
      "chainId": 8453,
      "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    },
    "message": {
      "from": "0xe44c8b0D235967E4A52BaCA6f93329C79056DaB4",
      "to": "0xF0F11bbce394Cf780a20f8A7F63490F50a175A26",
      "value": "1020000",
      "validAfter": "0",
      "validBefore": "1790389563",
      "nonce": "0xe42c9a46ec40b397fa95c067387e33a3fa82d960ee6582b3edc119025ed49b94"
    },
    "stake": "1000000",
    "fee": "20000",
    "feeBps": "200"
  }
}
```

### Claiming

There is no claim endpoint yet; the relay does not claim for you. On v1.11 markets anyone
may call `claimPayoutFor(bettor, betIds)` and the payout always goes to `bettor`, or you can
call `claimPayout` / `claimAllPayouts` yourself, which needs a little ETH. See **Claiming**
below.

---

## Contract Addresses

### Base Mainnet

| Contract | Address |
|---|---|
| SportsbookFactory v1.6 | `0x5906370b9831728ec523b647137a1bbf0ab45390` *(live; creates SportsbookMarket v1.11 markets)* |
| MarketDeployer v1.1 | `0xb86d291104d23d47906776538db82191681257c2` *(holds SportsbookMarket v1.11 creation bytecode; pinned by v1.6 as an immutable at construction)* |
| ~~SportsbookFactory v1.5~~ | ~~`0xf69d4c986bb9fa8177e74b8cb9e2c49f4200adbd`~~ *(superseded by v1.6; its SportsbookMarket v1.10 markets still settle and claim normally)* |
| ~~MarketDeployer v1.0~~ | ~~`0xa88b73cff7187f84f5615e396c5bf34daeea1d70`~~ *(v1.10 bytecode; used only by Factory v1.5)* |
| ~~SportsbookFactory v1.4~~ | ~~`0xB09aD0b9B52E628328151505580be1A632326E0c`~~ *(superseded by v1.5; markets it created still settle and claim normally)* |
| ~~SportsbookFactory v1.3~~ | ~~`0x9E9C769aaCa509cD67Fbca2236dB26d8428a8027`~~ *(superseded — UMA identifier bug, use triggerRefund() on stranded markets)* |
| ~~SportsbookFactory v1.2~~ | ~~`0x08BA5624107536d1CEA043B372978E7e9516E214`~~ *(retired)* |
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| UMA OOV3 | `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c` |

SportsbookFactory v1.6, MarketDeployer v1.1 and the v1.11 markets are verified on BaseScan.

**`createMarket` signature since v1.5** — `(string gameId, int256 oracleZ, uint256 protocolSeed)`,
a breaking change from v1.4's `(gameId, oracleZ)` and unchanged in v1.6. This does not affect
agents (only the factory owner/operator calls it), but note it if you're reading factory deploy
logs.

Markets are deployed per game by the factory. Use `getOpenMarkets()` to discover active markets.

### Base Sepolia (Testnet)

| Contract | Address |
|---|---|
| USDC (Circle testnet) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` |
| UMA OOV3 | `0x0F7fC5E6482f096380db6158f978167b57388deE` |

---

## Data Types

All USDC amounts are in 6 decimal units: `1 USDC = 1_000_000 = 1e6`

`finalSpread` is a whole integer: `7` means home team won by 7, `-3` means away team won by 3, `0` is a tie.

`lockedZ` and `currentZ` are 4-decimal fixed-point: `-35000` means `-3.5` (home team -3.5 favorite).

Win condition: `finalSpread * 10000` compared against `lockedZ`.

The protocol fee is `stake * FEE_PERCENT / 10000` (200 bps = 2%), added on top of the stake and pulled together in `placeBet()`. Only the stake enters the pool.

---

## Market Discovery

### Get all open markets
```solidity
address[] memory markets = factory.getOpenMarkets();
```

### Get full market snapshot
```solidity
(
    string memory gameId,
    bool isOpen,
    bool isSettled,
    bool isCanceled,
    int256 currentZ,
    uint256 totalPool,
    int256 spreadMax,
    int256 spreadMin,
    uint256 feePercent,
    bool refundAvailable
) = factory.getMarketInfo(marketAddress);
```

### Get market by game ID
```solidity
// Public mapping getter — pass the gameId string directly
address market = factory.marketByGameId("NFL-2026-01-15-HOME-Chiefs-AWAY-49ers");
```

### Get markets needing settlement
```solidity
address[] memory unsettled = factory.getUnsettledMarkets();
```

---

## Pre-Bet Evaluation

### Market state
```solidity
(
    string memory gameId,
    int256 z,           // current Z line (4-decimal)
    uint256 gPool,      // total USDC on greaterThan side (stakes only)
    uint256 lePool,     // total USDC on lessEqual side (stakes only)
    uint256 tPool,      // total pool: stakes + seed (fees never enter the pool)
    bool isOpen,
    bool isSettled
) = market.getMarketState();
```

### Expected value
```solidity
(
    uint256 currentPayout,   // gross pool payout at current pool ratio
    uint256 liquidPayout,    // gross pool payout at liquidity (balanced pools)
    uint256 impliedVig       // protocol fee in bps (200 = 2%)
) = market.getMarketEV(stake, greaterThan);
```

**Reading `currentPayout`:** Gross return from the pool if the market closed right now. Divide by stake for the multiplier. Use this to capture early-imbalance opportunity. Remember the 2% fee was paid on your stake at placement, so net profit = currentPayout − stake − fee.

**Reading `liquidPayout`:** Payout at liquidity, when the Z line has balanced the pools — your steady-state EV. At balance, a $100 stake returns **exactly** $200 gross — this is exact, not an approximation a thin pool merely approaches — net of the $2 placement fee, exactly $98 profit — 2% friction, full stop. This is the number to use for long-run EV modeling. If `currentPayout > liquidPayout`, you're locking favorable early-market odds before opposing flow arrives. If they're equal, the market is already at equilibrium.

> **Legacy markets only — SportsbookMarket v1.9 and earlier (Factory v1.4 and older)
> under-quote.** Fixed on-chain in v1.10: on every market from Factory v1.5 or v1.6,
> `getMarketEV`/`simulatePayout` already exclude the seed and `liquidPayout` is exactly
> `stake * 2`, so no correction is needed. On a legacy market, the `liquidPayout`/`currentPayout`
> denominators are `greaterPool`/`lessEqualPool` (or `simTotal/2` for liquidPayout) *without*
> excluding that side's share of `PROTOCOL_SEED` — so they return a number slightly below the true
> payout, worst on thin pools and converging to correct as pools deepen. Real settlement
> (`_calculatePayout`/`_sumWinningStakes`) never counts the seed as a winning stake in any
> version, so this is purely a quoting issue — it does not mean you'll actually be paid less. If
> you quote a legacy market directly, apply the fix yourself:
>
> ```solidity
> // Same math getMarketEV() already does, with PROTOCOL_SEED stripped from
> // the winning-side denominator only — never from `distributable`, which
> // already correctly subtracts the aggregate protocolSeedTotal (stripping
> // it there too would double-count).
> uint256 simSide          = greaterThan ? gPool + stake : lePool + stake;
> uint256 simTotal          = tPool + stake;
> uint256 distributable     = simTotal - protocolSeedTotal;
> uint256 realWinningStake  = simSide - PROTOCOL_SEED;
> uint256 correctedCurrentPayout = stake * distributable / realWinningStake;
> uint256 realLiquidSide    = (simTotal / 2) - PROTOCOL_SEED;
> uint256 correctedLiquidPayout  = stake * distributable / realLiquidSide;
> ```

**`impliedVig`:** The complete protocol cost in basis points. 200 = 2%. Charged on your stake at placement; there is no settlement haircut, so 2% is the entire story. Compare directly against sportsbook vig (~450 bps at -110) or order-book platforms' stacked taker-fee + overround + slippage. Pool imbalance is a transient early-market condition that the Z line self-corrects — it is not a structural cost.

### Kelly criterion
```javascript
const grossMultiplier = Number(liquidPayout) / Number(stake); // exactly 2.0 at liquidity (v1.10+; legacy markets need the note above)
const netOdds = grossMultiplier - 1;
const feeRate = Number(impliedVig) / 10000;                   // 0.02
// Cost basis includes the 2% placement fee on stake
const kellyFraction = (probability * netOdds - (1 - probability) * (1 + feeRate)) / netOdds;
const betSize = bankroll * kellyFraction;
```

For steady-state sizing, use `liquidPayout` as the gross multiplier input. For opportunity sizing on early-imbalance markets, use `currentPayout`. In both cases the 2% fee is charged on your stake at placement, so factor `stake * (1 + impliedVig / 10000)` as your true cost.

---

## Placing a Bet

Minimum bet: 1 USDC (1e6). Maximum: limited by `betsRemaining` (1000 cap per market).

When you bet, the contract pulls `stake + fee` where `fee = stake * FEE_PERCENT / 10000`. The stake enters the pool; the fee is swept to the market owner in the same transaction.

```solidity
// Always use max approval — Circle USDC on Base rejects exact-amount approvals.
// Max approval also covers stake + fee in one go.
usdc.approve(marketAddress, type(uint256).max);

// Place bet
// greaterThan = true:  betting finalSpread * 10000 > lockedZ
// greaterThan = false: betting finalSpread * 10000 <= lockedZ
market.placeBet(greaterThan, stake);
```

Your `lockedZ` is the Z line at the moment your transaction is included in a block. Future bets do not affect your locked Z.

---

## Non-Custodial Betting via `placeBetFor` (v1.10 and v1.11 — LIVE on Base mainnet)

`placeBetFor` lets a **relay** submit a bet that **you** own. You sign an EIP-3009
authorization for your stake; the relay pays the gas and submits the transaction; the
contract records *you* as the bettor. The relay never holds your funds, and your payout can
only ever be paid to you. This section is the contract-level interface; to have Even Steven's
relay submit for you over HTTP, use **Placing a bet via the relay (POST /api/bet)** above.

```solidity
struct Authorization {
    uint256 validAfter;   // EIP-3009 validAfter  (unix seconds)
    uint256 validBefore;  // EIP-3009 validBefore (unix seconds)
    bytes32 nonce;        // MUST equal keccak256(abi.encode(salt, greaterThan))
    bytes32 salt;         // your randomness
    uint8   v;
    bytes32 r;
    bytes32 s;
}

market.placeBetFor(bettor, greaterThan, stake, auth);
```

**Anyone may call it.** There is deliberately no relay allowlist — the only authorization
that counts is your signature, which USDC itself verifies.

### Two things that will silently break a naive x402 integration

**1. Sign `ReceiveWithAuthorization`, not `TransferWithAuthorization`.**

x402's `exact` EVM scheme uses `transferWithAuthorization`. Even Steven uses
**`receiveWithAuthorization`**, which USDC only lets the payee redeem. This is deliberate:
`transferWithAuthorization` can be submitted by anyone who sees it, so an observer could
redeem your authorization straight at USDC — your funds would land in the market with **no
bet recorded** and the spent nonce would make the real `placeBetFor` revert.

**2. The nonce is structured, not random.**

```
nonce = keccak256(abi.encode(salt, greaterThan))
```

The EIP-3009 signature covers `(from, to, value, validAfter, validBefore, nonce)` — it does
**not** cover which side of the line you are betting. Without this binding, a relay could
take an authorization you signed for "greater than" and place it on "less than or equal",
taking the other side against you. Encoding the side into the signed nonce makes your
signature a commitment to one side.

A vanilla random x402 nonce is rejected with `BadAuthorizationNonce()` — a distinct custom
error, not a generic signature failure.

> **`salt` must be unique per bet, globally — not merely per market.** USDC tracks spent
> nonces per `(authorizer, nonce)` across the whole token, not per recipient. Reusing a
> `salt` for the same side on a *different* market produces the same nonce and is rejected
> as already used.

### Which bet function your wallet needs (v1.11 — markets from Factory v1.6)

> `placeBetForWithSignature` exists only on **SportsbookMarket v1.11**, the markets created
> by Factory v1.6. v1.10 markets (Factory v1.5) have `placeBetFor` only. `placeBetFor` is
> unchanged between the two.

USDC verifies the EIP-3009 signature itself: with `ecrecover` when the signer has no code,
and through **ERC-1271** (`isValidSignature`) when it does. That single fact decides which
entry point a wallet needs.

| Signer | Use | Why |
|---|---|---|
| Plain EOA | `placeBetFor` | 65-byte ECDSA fits `(v, r, s)` |
| EOA upgraded via EIP-7702 (e.g. MetaMask) | `placeBetFor` | MetaMask's delegate verifies plain 65-byte ECDSA |
| Smart-contract wallet with a non-standard envelope | `placeBetForWithSignature` | Its signature is not 65 bytes and has no `(v, r, s)` form |

* **EOAs, including MetaMask accounts upgraded via EIP-7702, use `placeBetFor`.** Confirmed
  against MetaMask's real deployed delegate — `EIP7702StatelessDeleGator` at
  `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` on Base: its `isValidSignature` is a plain
  `ECDSA.recover(hash, signature) == address(this)` with no replay-safe wrapping, so it
  verifies a raw EIP-3009 digest and fits `placeBetFor`'s existing `v, r, s` shape.
* **`placeBetForWithSignature` is for wallets whose signature is NOT 65-byte ECDSA** — for
  example Coinbase Smart Wallet-style envelopes such as `abi.encode(ownerIndex, ecdsaSig)`,
  and any other ERC-1271 wallet with a non-standard signature format. It takes the same
  arguments as `placeBetFor` except that `auth.signature` is opaque `bytes`:

  ```solidity
  struct AuthorizationBytes {
      uint256 validAfter;
      uint256 validBefore;
      bytes32 nonce;      // still keccak256(abi.encode(salt, greaterThan))
      bytes32 salt;
      bytes   signature;  // EOA: abi.encodePacked(r,s,v). Contract wallet: its own format.
  }

  market.placeBetForWithSignature(bettor, greaterThan, stake, auth);
  ```

  Every other rule is identical to `placeBetFor`: the same `R6-2` nonce derivation, the same
  `BadAuthorizationNonce()` on a mismatch, the bettor recorded as the owner, and funds moving
  only from the bettor to the market. An EOA may use either function.
* **For a wallet not listed above**, the outcome depends on whether the signer's code — a
  permanent smart-contract wallet, or a 7702 delegate — implements ERC-1271 and accepts a
  **raw digest**. A delegate that only validates its own internal message format, or that
  does not implement ERC-1271 at all, fails through **both** functions. That is a
  USDC/wallet compatibility question, not something this contract can special-case.
* **`claimPayoutFor` requires no signature from any wallet type.** Nothing is signed for a
  claim, so wallet format is irrelevant to collecting a payout.

### Signing (viem)

```ts
const domain = {
  name: 'USD Coin',
  version: '2',                 // NOT '1' and NOT '2.2' — verified on-chain
  chainId: 8453,
  verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // the PROXY address
}

const types = {
  ReceiveWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
}

const feePercent = await publicClient.readContract({   // set per market — never hardcode
  address: marketAddress,
  abi: parseAbi(['function FEE_PERCENT() view returns (uint256)']),
  functionName: 'FEE_PERCENT',
})
const fee   = stake * feePercent / 10000n
const value = stake + fee               // sign for stake + fee, in ONE authorization

const salt  = crypto.getRandomValues(new Uint8Array(32))  // unique per bet
const nonce = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]
))

const signature = await account.signTypedData({
  domain, types, primaryType: 'ReceiveWithAuthorization',
  message: { from: account.address, to: marketAddress, value,
             validAfter: 0n, validBefore, nonce },
})
```

Sign for **`stake + fee`** in a single authorization. The full amount is pulled into the
market, the fee is swept to the market owner in the same transaction, and only the stake
enters the pool — exactly as in `placeBet()`.

### Failure modes

Errors raised by the market are custom errors and decode by name from the ABI:

| Error | Meaning | Retry? |
|---|---|---|
| `BadAuthorizationNonce()` | Nonce is not `keccak256(salt, greaterThan)` — usually a random x402 nonce, or a relay trying to flip your side | Re-sign with the correct derivation |
| `InvalidBettor()` | `bettor` was the zero address | Fix the call |
| `BettingIsClosed()` | Betting has closed | Switch markets |
| `MarketEnded()` | Settled or canceled | Switch markets |
| `BelowMinBet()` | Stake under 1 USDC | Raise the stake |
| `MarketFull()` | 1000-bet cap reached | Switch markets |
| `FeeTransferFailed()` | Market owner cannot receive USDC | Do not retry; report |

Failures originating inside USDC surface as **revert strings**, not custom errors — match
on the text:

| String | Meaning | Retry? |
|---|---|---|
| `FiatTokenV2: invalid signature` | Bad signature, or a parameter that doesn't match what you signed (commonly a `stake` whose `stake + fee` differs from the signed `value`). Also what an ERC-1271 wallet returns when its `isValidSignature` rejects or reverts. A malformed 65-byte EOA signature fails earlier with `ECRecover: invalid signature` | Re-sign |
| `ECRecover: invalid signature length` | An empty or truncated signature passed to `placeBetForWithSignature` (v1.11). This is Circle's own error, not a contract custom error | Fix the signature |
| `FiatTokenV2: authorization is expired` | `validBefore` has passed | Re-sign with a new window |
| `FiatTokenV2: authorization is not yet valid` | `validAfter` is in the future | Wait |
| `FiatTokenV2: authorization is used or canceled` | Nonce already spent — usually a reused `salt` | Re-sign with a fresh salt |
| `ERC20: transfer amount exceeds balance` | Insufficient USDC for `stake + fee` | Top up |
| `Blacklistable: account is blacklisted` | Circle has blacklisted the address | Do not retry |
| `Pausable: paused` | Market is paused (v1.10 only — see below) | Retry later |

> **v1.11 changes two of these from strings to custom errors.** On markets created by
> Factory v1.6, match on the selector, not the text:
>
> | v1.10 revert string | v1.11 custom error | Selector |
> |---|---|---|
> | `Pausable: paused` | `MarketPaused()` | `0x54882d18` |
> | `Ownable: caller is not the owner` | `NotOwner()` | `0x30cd7471` |
>
> Both are market-only; the factory is unchanged. `unpause()` on a market that is not paused
> still reverts with OpenZeppelin's `Pausable: not paused` string — that one is deliberately
> untouched. Everything in the Circle table above is unchanged in v1.11: those strings come
> from USDC, not from this contract.

### Claiming

> **You need native ETH to claim — on markets created by Factory v1.5 (R6-9).** Placing a
> bet through `placeBetFor` is gasless for you: the relay pays the gas, you only sign.
> Claiming on v1.10 is not. `claimPayout()` is a direct call from your own address, so an
> agent funded purely in USDC can enter a position and then be unable to collect its
> winnings. Keep a small ETH balance on Base. The 90-day `CLAIM_TIMEOUT` gives you time to
> acquire gas.
>
> **R6-9 does NOT apply to markets created by Factory v1.6** (SportsbookMarket v1.11).
> Those expose `claimPayoutFor`, so anyone can claim on your behalf and you never need ETH
> at all. Check which factory created the market before assuming you need gas — see
> **Relayed claiming** below. Even Steven's relay does not yet offer a claim endpoint.

Claiming your own payout directly works on every version:

```solidity
market.claimPayout(betId);          // single
market.claimPayouts([id1, id2]);    // batch (v1.10) — reverts if any id is already claimed
market.claimAllPayouts();           // everything you hold in this market
```

`claimPayouts()` is atomic and strict: an already-claimed, non-winning, out-of-range or
someone-else's id reverts the whole batch and claims nothing. `claimAllPayouts()` is the
lenient variant — it skips what it cannot claim.

#### Relayed claiming — `claimPayoutFor` (v1.11 — markets from Factory v1.6)

```solidity
market.claimPayoutFor(bettor, [id1, id2]);   // submitted by ANY address
```

`claimPayoutFor` is **permissionless and takes no signature**. Any relay may call it, and
the USDC is **always** sent to `bettor` — the address recorded on the bet — never to
`msg.sender`. There is nothing for you to sign: EIP-3009 authorises USDC moving *from* a
signer, whereas a claim moves USDC from the market *to* you, and the fixed destination
makes a signature redundant. It works for every wallet type, including contract wallets.

Semantics match `claimPayouts()` exactly — strict and atomic. An already-claimed,
non-winning, out-of-range or someone-else's id reverts the whole call and moves nothing, so
a relay must submit only claimable ids. Like `claimPayout`, it is deliberately **not**
pausable: a pause must never block withdrawal of money already owed. It works in refund mode
too.

Two properties worth designing around:

* **Anyone can trigger your claim at a time you did not choose.** They cannot redirect or
  custody the funds — the destination is fixed to the bet's recorded bettor.
* **Your own claim may revert `AlreadyClaimed()` if a relay got there first.** That is not
  an error condition: the money has already landed in your address. Check your balance and
  the `BetClaimed` log before treating it as a failure.

---

## Settlement

Anyone can submit the result and anyone can execute after liveness. You are incentivized to do so — your payout is waiting.

```solidity
// Step 1: Check bond requirement
uint256 bond = market.getSettlementBond();

// Step 2: Approve bond (always use max — see approval note above)
usdc.approve(marketAddress, type(uint256).max);

// Step 3: Submit result (finalSpread is a whole integer)
market.requestSettlement(finalSpread);

// Step 4: Wait 2 hours for UMA liveness window

// Step 5: Finalize
market.executeSettlement();
```

**Bond mechanics:** Your bond is `max(UMA minimum, 100 USDC)` — on Base mainnet the UMA minimum is currently ~500 USDC. It is returned if the assertion is undisputed or upheld by UMA's DVM, and lost if your assertion is successfully disputed. Submit accurate results.

**No owner override:** `settle()` does not exist. Settlement paths are UMA assertion or `triggerRefund()` after 7 days. Fully trustless.

---

## Claiming Payouts

```solidity
// Claim all your bets in one transaction (preferred)
market.claimAllPayouts();

// Or claim a specific bet by ID
market.claimPayout(betId);

// Get your bet IDs
uint256[] memory betIds = market.getBetsByAddress(yourAddress);
```

Claim within 90 days of settlement. After 90 days, unclaimed funds are swept to the protocol.

---

## Events

Subscribe to these for real-time market monitoring:

```solidity
// New market opened
event MarketOpened(string gameId, int256 initialZ, uint256 seedPerSide);

// Bet placed — Z line may have moved. `fee` is the 2% swept to the owner at placement.
event BetPlaced(
    address indexed bettor,
    uint256 indexed betId,
    uint256 stake,
    uint256 fee,
    bool greaterThan,
    int256 lockedZ
);

// Z line moved
event ZUpdated(int256 newZ, uint256 greaterPool, uint256 lessEqualPool);

// Betting closed — no more bets accepted
event BettingClosed(uint256 timestamp);

// Settlement submitted to UMA
event SettlementRequested(bytes32 assertionId, int256 proposedSpread, address asserter);

// Market finalized — claim payouts now
event MarketSettled(int256 indexed finalSpread, bool refundMode, bool viaOracle);

// Payout claimed — the TOTAL moved in this transaction
event PayoutClaimed(address indexed bettor, uint256 amount);

// v1.11 markets only — per-bet claim attribution. One per bet claimed, on all four
// claim paths (claimPayout, claimAllPayouts, claimPayouts, claimPayoutFor). The
// BetClaimed payouts within one transaction sum to that transaction's PayoutClaimed.amount.
event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout);

// v1.11 markets only — emitted once at settlement, immediately before MarketSettled
// in the same transaction. Makes any bet's payout computable from logs alone.
event SettlementDetails(uint256 distributable, uint256 winningStakes);

// Market canceled — stake refunds available
event MarketCanceled(address indexed by);

// Safety net triggered — stake refunds available
event RefundTriggered(address indexed by);
```

`PayoutClaimed` and `MarketSettled` are **byte-identical** in v1.11 — same signature, same
topic0. All thirteen pre-existing events are unchanged; `BetClaimed` and `SettlementDetails`
are purely additive, so existing indexers need no change.

### Reconstructing a payout from logs alone (v1.11 markets)

With `SettlementDetails`, you can compute any bet's payout without an RPC call into the
market — useful for an indexer, or for checking a claim before submitting it:

```
payout = refundMode ? stake
                    : (isWinner ? stake * distributable / winningStakes : 0)

isWinner = greaterThan ? (finalSpread * 10000 >  lockedZ)
                       : (finalSpread * 10000 <= lockedZ)
```

`stake`, `greaterThan` and `lockedZ` come from that bet's `BetPlaced`; `finalSpread` and
`refundMode` from `MarketSettled`; `distributable` and `winningStakes` from
`SettlementDetails`. Use integer arithmetic and floor division — this is exactly what the
contract does, so the result matches the USDC you receive to the base unit. Note
`distributable` already excludes the protocol seed, which is returned to the protocol at
settlement and never competes with a winner's claim.

---

## gameId Format

```
"SPORT-YYYY-MM-DD-HOME-TeamName-AWAY-TeamName"
```

Examples:
```
"NFL-2026-01-15-HOME-Chiefs-AWAY-49ers"
"NBA-2026-05-15-HOME-Lakers-AWAY-Celtics"
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox"
"NHL-2026-04-22-HOME-Avalanche-AWAY-Lightning"
```

For MLB doubleheaders or split squad games on the same date, append `-G1`, `-G2`:
```
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox-G1"
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox-G2"
```

**Sign convention:**
- Positive `finalSpread` = HOME team won by that margin
- Negative `finalSpread` = AWAY team won by that margin
- Zero = tie

---

## Safety Nets

Three layers protect against stuck funds:

**1. `cancelMarket()`** — Owner calls for postponed/canceled games. Full stake returned; the placement fee is not refunded (it left the contract at placement). Available immediately.

**2. `triggerRefund()`** — Anyone calls after 7 days if market never settled. Full stake returned; the placement fee is not refunded.
```solidity
bool available = market.canTriggerRefund();
if (available) market.triggerRefund();
```

**3. `sweepUnclaimed()`** — Protocol sweeps after 90 days post-settlement. Any unclaimed funds go to protocol wallet.

No stake can be permanently locked. Every path terminates in either a settlement payout or a stake refund.

---

## Market Status

```solidity
(
    bool isCanceled,
    bool isPaused,
    bool assertionActive,    // UMA assertion currently pending
    uint256 claimDeadline,   // unix timestamp when 90-day claim window closes
    uint256 betsRemaining    // bets until 1000 cap
) = market.getMarketStatus();
```

---

## Strategy — Capturing Edge

These are not loopholes. They are the protocol working as designed — early liquidity is rewarded, and every mechanic here is transparent and verifiable on-chain. You still have to be right about the game; what follows lowers your cost and widens your edge when you are.

**1. Imbalance is an opportunity, not a risk.** When a market is lopsided — heavy flow on one side — the Z line has already moved to create favorable odds on the *minority* side. Taking the light side at that moment locks a favorable `lockedZ`, which means a wider band of final spreads pays you out than you would get at equilibrium. As opposing flow arrives and the pool rebalances, your locked position only improves relative to the crowd. The more volatile and imbalanced the market, the larger this early-mover edge.

**2. Read the edge directly from `getMarketEV`.** If `currentPayout > liquidPayout`, the market is currently imbalanced in your favor — you are catching an early edge before the Z line balances. If they are equal, the market is at equilibrium and you are getting the steady-state even payout. Poll this, or subscribe to `ZUpdated`, to find markets where the current imbalance favors the side you would take on the merits anyway. Do not chase imbalance for its own sake — pair it with a real view on the outcome.

**3. Earlier on the minority side means a wider winning range.** `lockedZ` is fixed at your bet time and never changes afterward. Locking a favorable Z early gives you a wider band of final spreads that win. See `z-line.md` for the worked example.

**4. Flat friction rewards volume and the long tail.** Friction is 2% on every market — Tuesday MLS, niche hockey props, college basketball — versus 5–20%+ on order books for those same illiquid markets. A strategy that is unprofitable on Polymarket after overround and slippage can clear on Even Steven. Because the fee is a single immutable constant, you can backtest with one friction number across every market and every time period.

**5. Size with Kelly on the true cost basis.** The 2% fee is charged on your stake, so your real cost is `stake * (1 + impliedVig / 10000)`. Fold that into your fraction (see the Kelly snippet under Pre-Bet Evaluation) rather than sizing off the gross payout alone.

**6. Settle your own winning markets.** After a game ends, call `requestSettlement()` yourself — do not wait for anyone else. Your bond returns once the assertion goes undisputed, and `executeSettlement()` unlocks your payout. For an agent already holding a winning position, self-settlement is the fastest path to realized profit.

---

## Constants

| Constant | Value | Notes |
|---|---|---|
| `PROTOCOL_SEED` | Per market (current markets: 1e6 = 1 USDC) | A per-market immutable since v1.10, set at creation and allowed to be 0 — read `PROTOCOL_SEED()` rather than assuming 1 USDC. Added per side at market open. Exists only so `_updateZ()`'s pool ratio is never a divide-by-zero before either side has a real bet — excluded from `distributable` and returned to the protocol at settlement, so it never dilutes a winner's payout |
| `FEE_PERCENT` | 200 on current markets | Flat protocol fee in bps (200 = 2%), charged on stake at placement. A per-market immutable fixed at creation — read `FEE_PERCENT()` rather than assuming 200 |
| `MIN_BOND` | 100e6 (100 USDC) | Floor; actual bond = max(UMA minimum, 100 USDC). Base mainnet UMA minimum ~500 USDC |
| `MAX_BETS` | 1000 | Per market cap |
| `REFUND_TIMEOUT` | 7 days | `triggerRefund()` becomes available |
| `CLAIM_TIMEOUT` | 90 days | `sweepUnclaimed()` becomes available |
| `K` | 50000 | Z line sensitivity |
| `Z_MAX` | 5000000 | +500.0000 in 4-decimal |
| `Z_MIN` | -5000000 | -500.0000 in 4-decimal |
| `MAX_POOL_RATIO` | 19 | Z math clamped above 19:1 imbalance |

---

## Full Function Reference

### SportsbookMarket

| Function | Signature | Notes |
|---|---|---|
| `placeBet` | `(bool greaterThan, uint256 stake)` | Min 1 USDC; pulls stake + 2% fee |
| `placeBetFor` | `(address bettor, bool greaterThan, uint256 stake, Authorization auth)` | v1.10+. Relayed bet via EIP-3009; `bettor` owns it |
| `placeBetForWithSignature` | `(address bettor, bool greaterThan, uint256 stake, AuthorizationBytes auth)` | v1.11. Same, for non-65-byte (ERC-1271) signatures |
| `requestSettlement` | `(int256 proposedSpread)` | Requires USDC bond approval |
| `executeSettlement` | `()` | Call after 2hr UMA liveness |
| `claimPayout` | `(uint256 betId)` | Single bet claim |
| `claimPayouts` | `(uint256[] betIds)` | v1.10+. Strict, atomic batch claim |
| `claimAllPayouts` | `()` | All bets in one tx |
| `claimPayoutFor` | `(address bettor, uint256[] betIds)` | v1.11. Anyone may submit; pays `bettor` |
| `FEE_PERCENT` | `()` | Taker fee in bps for this market |
| `triggerRefund` | `()` | After 7 days |
| `getMarketState` | `()` | Core state snapshot |
| `getMarketStatus` | `()` | Operational status |
| `getMarketEV` | `(uint256 stake, bool greaterThan)` | EV calculation (payouts gross of fee) |
| `getSettlementBond` | `()` | Required bond amount |
| `simulatePayout` | `(uint256 stake, bool greaterThan)` | Gross pool payout estimate |
| `canTriggerRefund` | `()` | Safety net availability |
| `getBetsByAddress` | `(address bettor)` | Your bet IDs |
| `getBet` | `(uint256 betId)` | Single bet details |

### SportsbookFactory

| Function | Signature | Notes |
|---|---|---|
| `getOpenMarkets` | `()` | All open markets |
| `getUnsettledMarkets` | `()` | Awaiting settlement |
| `getRefundableMarkets` | `()` | Refund available |
| `marketByGameId` | `(string gameId)` | Public mapping getter — lookup by game |
| `gameIdByMarket` | `(address market)` | Public mapping getter — empty string if this factory did not create the market |
| `getMarketInfo` | `(address market)` | Full snapshot + fee |
| `getAllMarkets` | `()` | Complete history |
| `getMarketCount` | `()` | Total markets created |

---

*Even Steven v1.11 (SportsbookFactory v1.6) — September 2026*
*Audited by Claude: five rounds, March–June 2026 (round 5 covers the v1.8.1 taker-fee model), plus three delta audits — August 2026 (v1.9 UMA identifier fix), September 2026 (v1.10 `placeBetFor`, Factory v1.5) and September 2026 v3 (v1.11 `claimPayoutFor` and `placeBetForWithSignature`, Factory v1.6). All critical and high findings are resolved except R-4 (High: no refund path if the owner abandons a market with betting open), which was deliberately not shipped and remains an accepted risk. Not a formal third-party audit. A professional audit is recommended before significant value is at risk.*
