# Even Steven — Agent & Developer Integration Guide

This document covers everything needed to programmatically interact with Even Steven markets. No UI required.

---

## Quick Start

```javascript
// 1. Find open markets
const markets = await factory.getOpenMarkets();

// 2. Evaluate a market
const [gameId, z, gPool, lePool, tPool, isOpen] = await market.getMarketState();
const [currentPayout, balancedPayout, impliedVig] = await market.getMarketEV(stake, greaterThan);

// 3. Approve and bet
await usdc.approve(marketAddress, ethers.MaxUint256);
await market.placeBet(greaterThan, stake);

// 4. Claim after settlement
await market.claimAllPayouts();
```

---

## Contract Addresses

### Base Sepolia (Testnet)

| Contract | Address |
|---|---|
| SportsbookMarket (latest) | `0xF536a69C12230FB094fA3C5850f8569957158AC2` |
| USDC (Circle testnet) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` |
| UMA OOV3 | `0x0F7fC5E6482f096380db6158f978167b57388deE` |

### Base Mainnet

Coming soon.

---

## Data Types

All USDC amounts are in 6 decimal units: `1 USDC = 1_000_000 = 1e6`

`finalSpread` is a whole integer: `7` means home team won by 7, `-3` means away team won by 3, `0` is a tie.

`lockedZ` and `currentZ` are 4-decimal fixed-point: `-35000` means `-3.5` (home team -3.5 favorite).

Win condition: `finalSpread * 10000` compared against `lockedZ`.

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
address market = factory.getMarketByGameId("NFL-2026-HOME-Chiefs-AWAY-49ers");
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
    uint256 gPool,      // total USDC on greaterThan side
    uint256 lePool,     // total USDC on lessEqual side
    uint256 tPool,      // total pool including seed
    bool isOpen,
    bool isSettled
) = market.getMarketState();
```

### Expected value
```solidity
(
    uint256 currentPayout,   // payout at current pool ratio
    uint256 balancedPayout,  // payout if pools reach perfect balance
    uint256 impliedVig       // protocol fee in bps (200 = 2%)
) = market.getMarketEV(stake, greaterThan);
```

**Reading currentPayout:** This is the gross return if the market closed right now. Divide by stake for the multiplier. Subtract stake for net profit.

**Reading balancedPayout:**
- Betting minority side: `balancedPayout > currentPayout` — you have favorable odds that worsen as more money balances the market
- Betting majority side: `balancedPayout < currentPayout` — you have unfavorable odds that improve as more money balances the market

**impliedVig:** This is the complete cost. 200 = 2%. No hidden spread, no maker-taker. Use this directly in EV calculations.

### Kelly criterion
```javascript
const grossMultiplier = Number(currentPayout) / Number(stake);
const netOdds = grossMultiplier - 1;
const kellyFraction = (probability * netOdds - (1 - probability)) / netOdds;
const betSize = bankroll * kellyFraction;
```

---

## Placing a Bet

Minimum bet: 1 USDC (1e6). Maximum: limited by `betsRemaining` (1000 cap per market).

```solidity
// Always use max approval — Circle USDC on Base rejects exact-amount approvals
usdc.approve(marketAddress, type(uint256).max);

// Place bet
// greaterThan = true:  betting finalSpread * 10000 > lockedZ
// greaterThan = false: betting finalSpread * 10000 <= lockedZ
market.placeBet(greaterThan, stake);
```

Your `lockedZ` is the Z line at the moment your transaction is included in a block. Future bets do not affect your locked Z.

---

## Settlement

Anyone can submit the result and anyone can execute after liveness. You are incentivized to do so — your payout is waiting.

```solidity
// Step 1: Check bond requirement
uint256 bond = market.getSettlementBond();

// Step 2: Approve bond
usdc.approve(marketAddress, bond > 0 ? bond : 1e6);

// Step 3: Submit result (finalSpread is a whole integer)
market.requestSettlement(finalSpread);

// Step 4: Wait 2 hours for UMA liveness window

// Step 5: Finalize
market.executeSettlement();
```

**Bond mechanics:** Your bond is returned if the assertion is undisputed or upheld by UMA's DVM. It is lost if your assertion is successfully disputed. Submit accurate results.

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

// Bet placed — Z line may have moved
event BetPlaced(
    address indexed bettor,
    uint256 indexed betId,
    uint256 stake,
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

// Market canceled — full refunds available
event MarketCanceled(address indexed by);

// Safety net triggered — full refunds available
event RefundTriggered(address indexed by);
```

---

## gameId Format

```
"SPORT-YEAR-HOME-TeamName-AWAY-TeamName"
```

Examples:
```
"NFL-2026-HOME-Chiefs-AWAY-49ers"
"NBA-2026-HOME-Lakers-AWAY-Celtics"
"MLB-2026-HOME-Yankees-AWAY-RedSox"
"NHL-2026-HOME-Avalanche-AWAY-Lightning"
```

**Sign convention:**
- Positive `finalSpread` = HOME team won by that margin
- Negative `finalSpread` = AWAY team won by that margin
- Zero = tie

---

## Safety Nets

Three layers protect against stuck funds:

**1. `cancelMarket()`** — Owner calls for postponed/canceled games. 100% refund, no fee. Available immediately.

**2. `triggerRefund()`** — Anyone calls after 7 days if market never settled. 100% refund, no fee.
```solidity
bool available = market.canTriggerRefund();
if (available) market.triggerRefund();
```

**3. `sweepUnclaimed()`** — Protocol sweeps after 90 days post-settlement. Any unclaimed funds go to protocol wallet.

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

## Constants

| Constant | Value | Notes |
|---|---|---|
| `PROTOCOL_SEED` | 1e6 (1 USDC) | Added per side at market open |
| `FEE_PERCENT` | 200 | 2% in basis points, set at deployment |
| `MIN_BOND` | 100e6 (100 USDC) | Minimum UMA assertion bond |
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
| `placeBet` | `(bool greaterThan, uint256 stake)` | Min 1 USDC |
| `requestSettlement` | `(int256 proposedSpread)` | Requires USDC bond approval |
| `executeSettlement` | `()` | Call after 2hr UMA liveness |
| `claimPayout` | `(uint256 betId)` | Single bet claim |
| `claimAllPayouts` | `()` | All bets in one tx |
| `triggerRefund` | `()` | After 7 days |
| `getMarketState` | `()` | Core state snapshot |
| `getMarketStatus` | `()` | Operational status |
| `getMarketEV` | `(uint256 stake, bool greaterThan)` | EV calculation |
| `getSettlementBond` | `()` | Required bond amount |
| `simulatePayout` | `(uint256 stake, bool greaterThan)` | Legacy EV estimate |
| `canTriggerRefund` | `()` | Safety net availability |
| `getBetsByAddress` | `(address bettor)` | Your bet IDs |
| `getBet` | `(uint256 betId)` | Single bet details |

### SportsbookFactory

| Function | Signature | Notes |
|---|---|---|
| `getOpenMarkets` | `()` | All open markets |
| `getUnsettledMarkets` | `()` | Awaiting settlement |
| `getRefundableMarkets` | `()` | Refund available |
| `getMarketByGameId` | `(string gameId)` | Lookup by game |
| `getMarketInfo` | `(address market)` | Full snapshot + fee |
| `getAllMarkets` | `()` | Complete history |
| `getMarketCount` | `()` | Total markets created |

---

*Even Steven v1.7 — March 2026*
*Audited by Claude Opus (3 rounds). All critical and high findings resolved.*
