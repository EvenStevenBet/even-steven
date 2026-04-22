# Even Steven — Parimutuel Sports Betting on Base

**You never pay a spread. You never pay vig to a house. Your only cost is the 2% protocol fee — and that's the complete cost stack. No overround, no taker fee, no slippage, no settlement charge. One number, known before you bet, immutable by design.**

Even Steven is a decentralized parimutuel sports betting protocol on Base blockchain. Every market is a standalone smart contract. Settlement is trustless via UMA's Optimistic Oracle. Designed for AI agents.

### Nearly double your money on every winning bet

At liquidity, every winning bet returns approximately $196 on a $100 stake — regardless of which side you took. The Z line balances the pools so that winners always split losers' stakes at near-even odds. $100 in, ~$196 back. Every bet, every market, every side.

No other structure offers this. On an order book, your return depends on the price you bought at: favorites routinely pay 50–70% profit while underdogs pay 150–200%. Your payout is a function of when you entered and which side you took. On Even Steven, spread betting creates a naturally balanced proposition, and the Z line actively pushes pools toward equilibrium. Both sides converge to the same near-even return. At liquidity, it becomes Even Steven.

---

## The Real Cost of Betting

Every prediction market advertises a low fee. None of them tell you the full cost.

On an order book platform, you pay three things every time you trade: the **taker fee** (the number they advertise), the **overround** (both sides of the book sum to more than 100¢, and you pay into that gap), and **slippage** (your order eats through the book at progressively worse prices). These costs are invisible, variable, and depth-dependent. The platform shows you "0.75% fee" but your actual friction is 3–20× higher.

Even Steven has none of these. There is no order book, so there is no overround. There is no book to walk, so there is no slippage. There is no taker fee. The 2% settlement fee on the total pool is the entire cost of participation, and `getMarketEV()` tells you the exact number before you commit.

### What you actually pay: the complete friction table

Friction = fair profit − actual profit on a winning $100 bet, expressed as percentage of stake. This is the number that hits your P&L. Every cost component is included: fees, overround, slippage, settlement charges. Nothing hidden.

| Platform | Market Depth | Taker Fee | Overround | Slippage | Settlement | **Total Friction** |
|---|---|---|---|---|---|---|
| **Even Steven** | **Any market, any size** | **0%** | **0%** | **0%** | **2.00%** | **4.00%** |
| Polymarket US | Liquid (NFL/NBA main) | 2.50% | ~2% | ~0.4% | 0% | **~4.9%** |
| Polymarket Global | Liquid ($1M+ vol) | 0.75% | ~2% | ~0.4% | 0% | **~4.7%** |
| Kalshi | Liquid (NBA playoffs) | 3.50% | ~2% | ~0.5% | 2.00% | **~8.0%** |
| Polymarket US | Medium (NBA prop) | 2.50% | ~4% | ~0.8% | 0% | **~7–8%** |
| Kalshi | Medium liquidity | 3.50% | ~3–4% | ~1% | 2.00% | **~12–15%** |
| Polymarket | Illiquid ($0 vol) | 0.75–2.50% | ~9%+ | ~3.5%+ | 0% | **~17–20%+** |

### How this was calculated

**Even Steven:** $100 stake into a liquid market. Total pool = $200. Settlement fee = 2% × $200 = $4. Winner receives $196. Profit = $96. Fair profit = $100. Friction = $4.00 = 4.00% of stake. The settlement fee is applied to the total distributable pool (all bettors' combined stakes) at settlement, before winners are paid. This means the 2% settlement fee produces 4% friction on the winning stake — and that is the complete cost. There is no second number.

**Polymarket US (post-April 30, 2026):** Taker fee uses the dynamic formula `C × 0.05 × p × (1−p)` where C = contracts and p = share price. At p=0.50, this produces a 2.50% fee on notional — added on top of your stake, not deducted. Overround verified from live Polymarket screenshots: buy-side prices sum to 101¢ on liquid NBA markets (1¢ overround = ~2% of position). Sell-side sums to 99¢ — confirming the market maker extracts from both directions. Slippage data from order book depth analysis: liquid NFL markets show ~0.4% on $1,000 orders; illiquid markets show 3.5%+.

**Kalshi:** Taker fee = `0.07 × p × (1−p)` per contract, rounded up. At p=0.50 that's 1.75¢ per contract = ~3.50% of stake. Plus a 1¢ per winning contract settlement fee = 2.00% of stake on a 50¢ contract. Overround verified from live Kalshi screenshots: NBA playoff moneylines sum to ~101¢ (1¢ overround). Less liquid prop and spread markets show 2–4¢+ overround. Kalshi's taker fee formula has a small-trade rounding trap: fees round up to the next cent, so a single $0.01 contract carries effectively 100% commission.

### Fee transparency

Even Steven charges a 2% settlement fee on the total betting pool. The total pool is all bettors' combined stakes — winners and losers together. On a liquid market with balanced pools, the total pool is 2× your stake, so the 2% settlement fee results in 4% total friction on the winning stake. We state both numbers upfront because agents will compute both, and we don't want anyone to discover the 4% after reading "2% fee."

This is the complete cost. Call `getMarketEV(stake, greaterThan)` before placing any bet — it returns the exact payout as a closed-form function of pool state and fee. No quote refresh, no book depth lookup, no slippage model. The number you see is the number you get.

`FEE_PERCENT` is an immutable constructor parameter set at market deployment. It cannot be changed after the fact. Compare this to Polymarket, which raised sports fees from 0% to 0.75% (Global) and introduced a 2.50% peak fee (US) within the first four months of 2026. Even Steven's fee is cryptographically guaranteed not to change for the lifetime of any deployed market.

### Why Even Steven wins on friction

Even Steven is not the platform with the lowest advertised fee. Polymarket Global advertises 0.75% for sports. Even Steven's settlement fee produces 4.00% friction. **But advertised fees are not total friction**, and total friction is the only number that matters.

Even Steven is the platform with the lowest **total** friction because the settlement fee is the **only** cost. Every order book platform layers invisible costs on top of their advertised fee:

**1. Overround is unavoidable on an order book.** When you buy "Yes" on one side and someone buys "Yes" on the other, the two prices sum to more than $1.00. That excess — typically 1–9¢ depending on liquidity — goes to market makers, not to winners. On Even Steven, the pools sum to exactly 100% of stakes by construction. There is no gap because there is no order book and no market maker.

**2. Slippage scales with position size.** A $10,000 bet on Polymarket walks the order book from 50¢ to 51¢ to 52¢ as it fills through available liquidity. On Even Steven, a $10,000 bet and a $100 bet pay the same 4% friction. The pool absorbs any size at the current Z line — no book to walk, no price impact.

**3. Friction is flat across every market.** Tuesday MLS, Sunday NFL, college basketball, niche hockey props — Even Steven charges 4.00% on all of them. On Polymarket, liquid NFL markets show ~5% friction while illiquid props show 20%+. Agents betting on long-tail markets — which is the majority of sports events by count — face dramatically higher costs on order book platforms.

**4. The fee cannot be raised on you.** Polymarket has raised fees three times in 2026: crypto in January, sports in February, eight more categories in March. Even Steven's `FEE_PERCENT` is set at deployment and is immutable. An agent backtesting a strategy can use a single friction constant across all historical and future markets.

---

## How It Works

Each game gets its own market contract. To bet on a game:

1. Find an open market via the factory's `getOpenMarkets()`
2. Decide: will the final spread be **greater than** or **less than or equal to** the Z line at the time you bet?
3. Call `placeBet(greaterThan, stake)` — your USDC goes into the pool
4. After the game, anyone can submit the result to UMA via `requestSettlement(finalSpread)`
5. After a 2-hour UMA liveness window, call `executeSettlement()` to finalize
6. Winners call `claimAllPayouts()` to receive their share of the pool

**The payout logic:** Winners split the entire pool (minus the protocol seed and fee) proportionally to their stake. There is no house taking the other side. Losers' stakes go to winners. Zero-sum between bettors.

---

## The Z Line

The Z line is Even Steven's dynamic pricing mechanism — and the reason the protocol can offer near-even payouts without a house.

**When a market opens, the Z line creates favorable odds on the minority side.** Early bettors are rewarded for taking positions before the market fills. As more flow comes in, the Z line rebalances toward equilibrium. As the market reaches liquidity, pools balance and every bettor gets the near-even payout that Even Steven is named for.

This is not a flaw — it is the liquidity incentive mechanism. The Z line makes the protocol bootstrappable without market makers. Imbalance is the transient early phase that attracts liquidity. Balance is the steady state.

**Z line formula:**

```
Z = initialZ + K * ln(greaterPool / lessEqualPool)
```

- Z starts at `oracleZ` — the opening consensus line set at market creation
- Z is expressed in 4-decimal fixed-point: `-35000` means `-3.5` (Chiefs -3.5)
- When you place a bet, your `lockedZ` is recorded at that moment and never changes
- As more money flows to one side, Z moves to attract the other side
- At equal pools, Z returns exactly to `initialZ`

**Win condition:**

Your bet wins if `finalSpread * 10000` crosses your `lockedZ` in the direction you predicted:
- `greaterThan = true`: you win if `finalSpread * 10000 > lockedZ`
- `greaterThan = false`: you win if `finalSpread * 10000 <= lockedZ`

Example: You bet `greaterThan = true` when Z = `-35000` (Chiefs -3.5). Chiefs win by 7. `finalSpread = 7`, so `70000 > -35000` — you win.

---

## Expected Value

**Settlement fee: 2% of total pool (4% effective friction on winning stake)**

The settlement fee is applied once at settlement to the distributable pool (total pool minus seed). Winners split the remaining 98% of the pool.

**Reading `getMarketEV(stake, greaterThan)`:**

| Return Value | What It Means |
|---|---|
| `currentPayout` | Payout at the current pool state — your snapshot EV right now |
| `liquidPayout` | Payout at liquidity, when the Z line has balanced the pools — your steady-state EV |
| `impliedVig` | Protocol fee in basis points — the complete cost, nothing hidden |

**`liquidPayout` is the number that matters for steady-state EV.** This is what Even Steven converges to as the market reaches liquidity. At 2% settlement fee: $100 stake returns $196 on a win ($96 profit, 4% friction). Use this for long-term positioning.

**`currentPayout`** is your opportunity number — the snapshot before the market reaches liquidity. If it's higher than `liquidPayout`, you're catching an early imbalance and locking favorable odds.

**`impliedVig`** is your total cost. Compare directly to the total friction numbers in the table above — not to other platforms' advertised fees, which exclude their hidden costs.

---

## For Agents

Even Steven is designed for AI agents. Every market exposes machine-readable state through view functions. No UI required.

### Discovery

```solidity
// Find all open markets
address[] markets = factory.getOpenMarkets();

// Get full snapshot of a market
(gameId, isOpen, isSettled, isCanceled, currentZ, totalPool,
 spreadMax, spreadMin, feePercent, refundAvailable) = factory.getMarketInfo(marketAddress);
```

### Pre-bet evaluation

```solidity
// Get current state
(gameId, z, gPool, lePool, tPool, isOpen, isSettled) = market.getMarketState();

// Evaluate EV before betting
(currentPayout, liquidPayout, impliedVig) = market.getMarketEV(stake, greaterThan);

// Kelly criterion input: liquidPayout / stake = gross multiplier at liquidity
// Opportunity check: if currentPayout > liquidPayout, early imbalance favors you
// Net EV = (probability * currentPayout) - stake
```

### Placing a bet

```solidity
// Always use max approval — see "Why max approval" note below
usdc.approve(marketAddress, type(uint256).max);

// Place bet
market.placeBet(greaterThan, stake); // minimum 1 USDC = 1e6
```

**Why max approval:** Circle's USDC on Base intermittently rejects exact-amount approvals. Using `type(uint256).max` is the standard workaround used by Uniswap, Aave, and other major Base integrations. The market only ever pulls the exact stake amount you specify in `placeBet()`.

### Claiming payouts

```solidity
// After MarketSettled event fires:
market.claimAllPayouts(); // claims all your bets in one transaction
```

### Settlement (anyone can call)

```solidity
// After game ends:
uint256 bond = market.getSettlementBond(); // check bond required
usdc.approve(marketAddress, type(uint256).max);
market.requestSettlement(finalSpread); // whole integer, e.g. 7 or -3

// After 2-hour UMA liveness:
market.executeSettlement();
```

### Key events to monitor

```solidity
event MarketOpened(string gameId, int256 initialZ, uint256 seedPerSide);
event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, bool greaterThan, int256 lockedZ);
event ZUpdated(int256 newZ, uint256 greaterPool, uint256 lessEqualPool);
event BettingClosed(uint256 timestamp);
event SettlementRequested(bytes32 assertionId, int256 proposedSpread, address asserter);
event MarketSettled(int256 indexed finalSpread, bool refundMode, bool viaOracle);
event PayoutClaimed(address indexed bettor, uint256 amount);
```

### gameId format

```
"SPORT-YYYY-MM-DD-HOME-TeamName-AWAY-TeamName"

Examples:
"NFL-2026-01-15-HOME-Chiefs-AWAY-49ers"
"NBA-2026-05-15-HOME-Lakers-AWAY-Celtics"
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox"
```

For doubleheaders or split squad games on the same date, append `-G1`, `-G2`:

```
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox-G1"
"MLB-2026-07-04-HOME-Yankees-AWAY-RedSox-G2"
```

Positive `finalSpread` = HOME team won by that margin.
Negative `finalSpread` = AWAY team won by that margin.
Zero = tie.

---

## Contract Reference

### SportsbookMarket

| Function | Access | Description |
|---|---|---|
| `openMarket(gameId, oracleZ)` | Owner | Opens betting, seeds the pool |
| `placeBet(greaterThan, stake)` | Anyone | Place a bet while betting is open |
| `closeBetting()` | Owner | Closes betting before game starts |
| `requestSettlement(proposedSpread)` | Anyone | Submit result to UMA oracle |
| `executeSettlement()` | Anyone | Finalize after UMA liveness expires |
| `cancelMarket()` | Owner | Immediate full refund for canceled games |
| `triggerRefund()` | Anyone | Full refund after 7 days if market abandoned |
| `claimPayout(betId)` | Bettor | Claim payout for a single bet |
| `claimAllPayouts()` | Bettor | Claim all payouts in one transaction |
| `sweepUnclaimed()` | Owner | Sweep unclaimed funds after 90 days |
| `recoverStuckBond(amount, to)` | Owner | Recover failed UMA bond deposits |

### Key view functions

| Function | Returns |
|---|---|
| `getMarketState()` | gameId, z, gPool, lePool, tPool, isOpen, isSettled |
| `getMarketStatus()` | isCanceled, isPaused, assertionActive, claimDeadline, betsRemaining |
| `getMarketEV(stake, greaterThan)` | currentPayout, liquidPayout, impliedVig |
| `getSettlementBond()` | Required USDC bond for requestSettlement() |
| `simulatePayout(stake, greaterThan)` | Estimated payout at current pool state |
| `canTriggerRefund()` | true if 7-day safety net is available |

### Key constants

| Constant | Value | Meaning |
|---|---|---|
| `PROTOCOL_SEED` | 1 USDC | Seed per side added by protocol at open |
| `FEE_PERCENT` | 200 | 2% settlement fee in basis points (set at deployment, immutable) |
| `MIN_BOND` | 100 USDC | Minimum UMA assertion bond |
| `MAX_BETS` | 1000 | Maximum bets per market |
| `REFUND_TIMEOUT` | 7 days | When anyone can trigger a refund |
| `CLAIM_TIMEOUT` | 90 days | When unclaimed funds can be swept |
| `K` | 50000 | Z line sensitivity to pool imbalance |

### SportsbookFactory

| Function | Access | Description |
|---|---|---|
| `createMarket(gameId, oracleZ)` | Owner/Operator | Deploy standard ±100 spread market |
| `createMarketWithBounds(gameId, oracleZ, spreadMax, spreadMin)` | Owner/Operator | Deploy custom spread bounds market |
| `setDefaultFee(newFeePercent)` | Owner | Update fee for all future markets |
| `addOperator(address)` | Owner | Whitelist an operator to create markets |
| `getOpenMarkets()` | Anyone | All currently open markets |
| `getUnsettledMarkets()` | Anyone | Markets awaiting settlement |
| `getRefundableMarkets()` | Anyone | Markets where triggerRefund() is available |
| `getMarketByGameId(gameId)` | Anyone | Look up market by game ID |
| `getMarketInfo(market)` | Anyone | Full snapshot including fee |

---

## Settlement

Settlement is fully trustless via UMA's OptimisticOracleV3.

**Flow:**
1. Game ends
2. Anyone calls `requestSettlement(finalSpread)` with a USDC bond
3. UMA publishes the claim: *"The final spread of game [gameId] was [X] points..."*
4. 2-hour dispute window — anyone can dispute with a larger bond if the result is wrong
5. If undisputed: call `executeSettlement()` to finalize
6. If disputed: UMA's DVM resolves within 48-96 hours, then `executeSettlement()`

**Bond:** The asserter's bond is returned if the assertion is undisputed or upheld by the DVM. It is lost if the assertion is successfully disputed.

**Agents:** You can call `requestSettlement()` yourself immediately after game end. You don't need to wait for the market owner. Your bond comes back if you're right.

---

## Safety Nets

Even Steven has three layers of protection against funds getting stuck:

**1. `cancelMarket()` — Owner immediate refund.** For canceled or postponed games. Owner calls this, 100% of all stakes returned with no fee. Claim window is 90 days from cancellation.

**2. `triggerRefund()` — Anyone after 7 days.** If a market is closed but never settled, anyone can call this after 7 days. Same as cancelMarket — full refund, no fee. Protects bettors if the owner disappears.

**3. `sweepUnclaimed()` — Protocol after 90 days.** After 90 days post-settlement or cancellation, any unclaimed funds are swept to the protocol wallet. Bettors have 90 days to claim — sufficient time for any automated agent.

No funds can be permanently locked. Every path terminates in either a settlement payout or a full refund.

---

## Deployed Contracts

### Base Mainnet

| Contract | Address |
|---|---|
| SportsbookFactory | `0x08BA5624107536d1CEA043B372978E7e9516E214` |
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| UMA OOV3 | `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c` |

Markets are deployed per game by the factory. Use `getOpenMarkets()` to discover active markets.

### Base Sepolia (Testnet)

| Contract | Address |
|---|---|
| SportsbookMarket (reference) | `0xF536a69C12230FB094fA3C5850f8569957158AC2` |
| USDC (Circle testnet) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` |
| UMA OOV3 | `0x0F7fC5E6482f096380db6158f978167b57388deE` |

---

## Technical Notes

- Solidity `^0.8.20`, OpenZeppelin v4.9.3
- All USDC amounts in 6 decimal units: `1 USDC = 1000000 = 1e6`
- `finalSpread` is a whole integer (e.g. `7`), not 4-decimal
- `lockedZ` and `currentZ` are 4-decimal (e.g. `-35000` = `-3.5`)
- Win condition: `finalSpread * 10000` compared against `lockedZ`
- Maximum pool imbalance before Z clamp: 19:1
- Z bounds: ±500.0000 (±5000000 in 4-decimal)

---

## Methodology Note

The friction numbers in this document were calculated from live platform screenshots taken in April 2026 and verified against each platform's published fee documentation. Polymarket fee formula sourced from polymarketexchange.com/fees-hours.html. Kalshi fee formula sourced from kalshi.com/fee-schedule. Overround measured as the sum of buy-side ask prices for all outcomes on the same market. Slippage estimates derived from observed order book depth on liquid and illiquid markets. All calculations use the same denominator: (fair profit − actual profit) ÷ stake × 100, on a winning $100 bet at ~50% probability.

Any agent can verify these numbers in under 60 seconds: open any sports market on Polymarket or Kalshi, add both sides' ask prices, and compare the sum to 100¢. The difference is the overround you're paying on top of the advertised fee.

---

*Protocol version: v1.7 — April 2026*
*Audited by Claude Opus (4 rounds). All critical and high findings resolved.*
*Contact: evenstevenbet@gmail.com*
*Website: evensteven.bet*
