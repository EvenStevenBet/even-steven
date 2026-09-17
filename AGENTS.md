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

**These endpoints are read/quote only. There is no `POST /api/bet`** — see **v2 note** below.

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
formula (see the correction note under **Pre-Bet Evaluation**) — they are accurate as returned, no
client-side adjustment needed. This differs from calling `getMarketEV`/`simulatePayout` directly
against the contract, which still under-quotes.

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
    "note": "POST /api/bet is not available — agent write betting requires v2 contract (placeBetFor). Coming soon.",
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
  "note": "POST /api/bet not available on v1. v2 placeBetFor coming in 1-2 weeks."
}
```

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

### v2 note

**`POST /api/bet` is not available yet.** On the currently deployed v1.9 contract,
`placeBet()` records `msg.sender` as the bettor, so a server-side relay would have to custody
agent funds — Even Steven does not do that.

The contract-side unlock is built: **`placeBetFor()` in SportsbookMarket v1.10**, which
records the EIP-3009 *signer* as the bettor rather than the submitter. It is verified against
a Base mainnet fork but **not yet deployed to mainnet**, and the write endpoint is built on
top of it once it is. See **Non-Custodial Betting via `placeBetFor`** below for the
integration shape — including two divergences from a vanilla x402 payload that will
otherwise fail signature verification.

Until then, agents place bets themselves directly against the contract (see **Quick Start**
above and **Placing a Bet** below) — the x402 endpoints above are read/quote only.

---

## Contract Addresses

### Base Mainnet

| Contract | Address |
|---|---|
| SportsbookFactory v1.4 | `0xB09aD0b9B52E628328151505580be1A632326E0c` |
| ~~SportsbookFactory v1.3~~ | ~~`0x9E9C769aaCa509cD67Fbca2236dB26d8428a8027`~~ *(superseded — UMA identifier bug, use triggerRefund() on stranded markets)* |
| ~~SportsbookFactory v1.2~~ | ~~`0x08BA5624107536d1CEA043B372978E7e9516E214`~~ *(retired)* |
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| UMA OOV3 | `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c` |

Deploy tx: [`0x2ec96b82ced224a4eefa68b7b75ae30f20bb1ec810c069d94efbeb00408f0d25`](https://basescan.org/tx/0x2ec96b82ced224a4eefa68b7b75ae30f20bb1ec810c069d94efbeb00408f0d25) — Basescan verified, Exact Match.

Markets are deployed per game by the factory. Use `getOpenMarkets()` to discover active markets.

### Base Sepolia (Testnet)

| Contract | Address |
|---|---|
| SportsbookMarket (reference) | `0xF536a69C12230FB094fA3C5850f8569957158AC2` |
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

> **Correction — the deployed contract's `getMarketEV`/`simulatePayout` currently under-quote.**
> Their `liquidPayout`/`currentPayout` denominators are `greaterPool`/`lessEqualPool` (or `simTotal/2`
> for liquidPayout) *without* excluding that side's share of `PROTOCOL_SEED` — so calling these
> functions directly on-chain returns a number slightly below the true payout, worst on thin pools
> and converging to correct as pools deepen. Real settlement (`_calculatePayout`/
> `_sumWinningStakes`) never counts the seed as a winning stake, so this is purely a quoting issue —
> it does not mean you'll actually be paid less. Even Steven's own x402 endpoints below already
> apply the correction server-side; if you call `getMarketEV`/`simulatePayout` directly against the
> contract instead, apply the same fix yourself:
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
const grossMultiplier = Number(liquidPayout) / Number(stake); // exactly 2.0 at liquidity, once corrected (see note above)
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

## Non-Custodial Betting via `placeBetFor` (v1.10 — NOT YET DEPLOYED)

> **Status: built and verified against a Base mainnet fork, awaiting testnet rehearsal and
> mainnet deploy.** The addresses in **Contract Addresses** below are still v1.9/v1.4, which
> do **not** have this function. Do not integrate against it on mainnet yet.

`placeBetFor` lets a **relay** submit a bet that **you** own. You sign an EIP-3009
authorization for your stake; the relay pays the gas and submits the transaction; the
contract records *you* as the bettor. The relay never holds your funds, and only you can
claim your payout.

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

const fee   = stake * 200n / 10000n     // market.FEE_PERCENT()
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
| `FiatTokenV2: invalid signature` | Bad signature, or a parameter that doesn't match what you signed (commonly a `stake` whose `stake + fee` differs from the signed `value`) | Re-sign |
| `FiatTokenV2: authorization is expired` | `validBefore` has passed | Re-sign with a new window |
| `FiatTokenV2: authorization is not yet valid` | `validAfter` is in the future | Wait |
| `FiatTokenV2: authorization is used or canceled` | Nonce already spent — usually a reused `salt` | Re-sign with a fresh salt |
| `ERC20: transfer amount exceeds balance` | Insufficient USDC for `stake + fee` | Top up |
| `Blacklistable: account is blacklisted` | Circle has blacklisted the address | Do not retry |
| `Pausable: paused` | Market is paused | Retry later |

### Claiming

> **You need native ETH to claim.** Placing a bet through `placeBetFor` is gasless for you —
> the relay pays the gas, you only sign. **Claiming is not.** `claimPayout()` is a direct
> call from your own address, so an agent funded purely in USDC can enter a position and
> then be unable to collect its winnings. Keep a small ETH balance on Base for this. There
> is no relayed-claim entry point in v1.10; the 90-day `CLAIM_TIMEOUT` gives you time to
> acquire gas, and a `claimPayoutFor` is a v3 candidate.

You claim your own payout directly — the relay is not involved and cannot claim for you:

```solidity
market.claimPayout(betId);          // single
market.claimPayouts([id1, id2]);    // batch (v1.10) — reverts if any id is already claimed
market.claimAllPayouts();           // everything you hold in this market
```

`claimPayouts()` is atomic and strict: an already-claimed, non-winning, out-of-range or
someone-else's id reverts the whole batch and claims nothing. `claimAllPayouts()` is the
lenient variant — it skips what it cannot claim.

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

// Payout claimed
event PayoutClaimed(address indexed bettor, uint256 amount);

// Market canceled — stake refunds available
event MarketCanceled(address indexed by);

// Safety net triggered — stake refunds available
event RefundTriggered(address indexed by);
```

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
| `PROTOCOL_SEED` | 1e6 (1 USDC) | Added per side at market open. Exists only so `_updateZ()`'s pool ratio is never a divide-by-zero before either side has a real bet — excluded from `distributable` and returned to the protocol at settlement, so it never dilutes a winner's payout |
| `FEE_PERCENT` | 200 | Flat 2% protocol fee in bps, charged on stake at placement, set at deployment |
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
| `requestSettlement` | `(int256 proposedSpread)` | Requires USDC bond approval |
| `executeSettlement` | `()` | Call after 2hr UMA liveness |
| `claimPayout` | `(uint256 betId)` | Single bet claim |
| `claimAllPayouts` | `()` | All bets in one tx |
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
| `getMarketInfo` | `(address market)` | Full snapshot + fee |
| `getAllMarkets` | `()` | Complete history |
| `getMarketCount` | `()` | Total markets created |

---

*Even Steven v1.9 — September 2026*
*Audited by Claude Opus, five rounds, March–June 2026, plus a delta audit (August 2026) covering the v1.9 UMA identifier fix. All critical and high findings resolved. Not a formal third-party audit. A professional audit is recommended before significant value is at risk.*
