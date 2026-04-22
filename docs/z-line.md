# The Z Line

The Z line is Even Steven's dynamic pricing mechanism — and the reason the protocol can offer near-even payouts without a house or market makers.

## What the Z line does

The Z line moves based on betting activity to balance the pools. When pools are balanced, every bettor on the winning side earns nearly 1:1 on their stake — the near-even payout that Even Steven is named for.

The Z line is the liquidity incentive mechanism. When a market opens, the Z line creates favorable odds on the minority side. Early bettors who take minority positions lock favorable Z before the market fills. As opposing money flows in, the Z line rebalances toward equilibrium. By the time the market is mature, pools are balanced and every bettor gets the steady-state even payout.

Imbalance is the transient early phase. Balance is the steady state.

## What Z represents

Z is the line at which the bet splits into two sides:

- **Greater than:** You win if `finalSpread > lockedZ`
- **Less than or equal to:** You win if `finalSpread <= lockedZ`

Z is expressed in 4-decimal fixed-point. `-35000` means `-3.5` in spread terms. A Chiefs -3.5 opening line would have `initialZ = -35000`.

## How Z moves

Z is calculated using the natural log of the pool ratio:

```
Z = initialZ + K * ln(greaterPool / lessEqualPool)
```

Where `K = 50000` controls sensitivity.

When more money flows to the "greater than" side, Z rises. When more money flows to "less than or equal to," Z falls. At equal pools, Z returns exactly to `initialZ`.

This mirrors how sportsbooks move lines when action is lopsided — except here the movement is algorithmic, transparent, and designed to reach equilibrium, not extract vig.

**Example:** Market opens at `initialZ = -35000` with both pools at 1 USDC seed. A bettor stakes 10 USDC on "greater than." Now `greaterPool = 11`, `lessEqualPool = 1`. The ratio is 11:1, so `ln(11) ≈ 2.398`. New Z = -35000 + (50000 × 2.398) = +84,900. The line has shifted from Chiefs -3.5 all the way to Chiefs +8.5 — a massive swing from a single early bet, exactly what's needed to attract opposing flow back to the minority side.

## Locked Z

When you place a bet, your `lockedZ` is recorded at that moment and never changes.

Your win condition is fixed at the time you bet. Later bettors moving the Z line don't retroactively change whether you win or lose.

**Example:**

1. Market opens at Z = -35000 (Chiefs -3.5)
2. Heavy betting on "greater than" pushes Z to +10000 (Chiefs +1.0)
3. You bet "less than or equal to" at this point — your `lockedZ = +10000`
4. Chiefs win by 7. `finalSpread * 10000 = 70000`. Check: `70000 <= 10000` is false — you lose.
5. **If you had bet "less than or equal to" at step 1** with `lockedZ = -35000`: `70000 <= -35000` is also false — same outcome for this specific final spread. But your locked Z covers a different range of outcomes. At `lockedZ = +10000`, you'd win on any spread of +1 or worse for the home team — a wider winning range than `lockedZ = -35000`, but a position taken when the crowd was already heavy on the "greater than" side. The earlier you bet on the minority side, the wider your winning range tends to be at favorable Z values.

## Pool ratio clamp

The atanh series used to calculate `ln()` degrades above a 19:1 pool ratio. Above this threshold, the ratio is clamped to 19:1 before calculation. This caps maximum single-bet Z movement while preserving direction.

## Z bounds

Z is hard-clamped to ±500.0000 (±5000000 in 4-decimal). This prevents extreme imbalances from pushing Z into ranges where the win condition becomes meaningless — for example, a Z value beyond any plausible final spread would make all bets on one side trivially winning or losing. The bounds keep the market mathematically coherent even at the edges.

## Strategic implications

Betting early on the minority side locks a favorable Z before the market adjusts. Your position gets better as opposing money comes in — this is the early-bettor reward built into the protocol.

`getMarketEV(stake, greaterThan)` returns `currentPayout` and `liquidPayout` (the payout at liquidity, when pools are balanced). If `currentPayout > liquidPayout`, you're catching an early imbalance — favorable odds that improve your position relative to liquidity. If they're equal, the market is already balanced and you're getting the steady-state even payout.

The Z line means you're competing against other bettors in a transparent, algorithmic market — not against a sportsbook moving lines to extract vig, and not against an order book where market makers price you out. The line moves to balance the market, not to disadvantage you.
