# The Z Line

The Z line is Even Steven's dynamic pricing mechanism. It moves based on betting activity and determines how winners are identified at settlement.

---

## What Z represents

Z is the line at which the bet splits into two sides:

- **Greater than:** You win if `finalSpread > lockedZ`
- **Less than or equal to:** You win if `finalSpread <= lockedZ`

Z is expressed in 4-decimal fixed-point. `-35000` means `-3.5` in spread terms. A Chiefs -3.5 opening line would have `initialZ = -35000`.

---

## How Z moves

Z is calculated using the natural log of the pool ratio:

```
Z = initialZ + K * ln(greaterPool / lessEqualPool)
```

Where `K = 50000` controls sensitivity.

When more money flows to the "greater than" side, Z rises. When more money flows to the "less than or equal to" side, Z falls. At equal pools, Z returns exactly to `initialZ`.

This mirrors how sportsbooks move lines when action is lopsided — except here the movement is algorithmic and transparent.

---

## Locked Z

When you place a bet, your `lockedZ` is recorded at that moment and never changes.

This is important: your win condition is fixed at the time you bet. Later bettors moving the Z line don't retroactively change whether you win or lose.

**Example:**
1. Market opens at Z = -35000 (Chiefs -3.5)
2. Heavy betting on "greater than" pushes Z to +10000 (Chiefs +1.0)
3. You bet "less than or equal to" — your lockedZ = +10000
4. Chiefs win by 7. finalSpread = 7. `70000 <= 10000` is false — you lose.
5. If you had bet at step 1 with lockedZ = -35000: `70000 <= -35000` is false — also a loss in this case, but your locked position was different.

---

## Pool ratio clamp

The atanh series used to calculate ln() degrades in accuracy above a 19:1 pool ratio. Above this threshold, the ratio is clamped to 19:1 before calculation. This caps the maximum single-bet Z movement while preserving the direction.

In practice: very early bets on an empty market or very large bets can hit this clamp. Z will move significantly but not infinitely.

---

## Z bounds

Z is hard-clamped to ±500.0000 (±5000000 in 4-decimal). This prevents Z from moving into nonsensical territory even at extreme pool imbalances.

---

## Strategic implications

**Bet early on the unpopular side** — you lock a favorable Z before the market adjusts. Your position gets better as opposing money comes in.

**Bet late on the popular side** — Z has already moved against you. Your payout is diluted by the crowd of winners sharing the pool.

**`getMarketEV(stake, greaterThan)`** shows you `currentPayout` vs `balancedPayout` — the difference between your payout right now vs if the market reached perfect balance. This tells you whether you're on the crowded side or the favorable side.
