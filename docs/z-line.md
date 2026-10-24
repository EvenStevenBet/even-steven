# The Z Line

Z is the number the contract keeps for the line. It moves with the money to pull the two pools toward balance, so Even Steven needs no house betting against you.

## What Z does

Z moves as bets arrive. A balanced pool pays even money. When one side holds more money, Z moves to make the lighter side more attractive, and the next bet can move it again. Balance means equal money on both sides, and it is momentary: every bet moves the pools and the line.

Your bet locks the line in force when it lands, and that line never changes. Later bets move the line for later bettors. Your payout is set at settlement from the final pool.

## What Z represents

Z is the final spread (home score minus away score) at which a bet splits into two sides:

- **Home** (`greaterThan = true`): you win if `finalSpread * 10000 > lockedZ`
- **Away** (`greaterThan = false`): you win if `finalSpread * 10000 <= lockedZ`

Exactly one side wins every bet. There are no pushes: a tie (`finalSpread = 0`) goes to whichever side the rule above gives it.

Z is expressed in 4-decimal fixed-point, so `-35000` means `-3.5`. **The sign is from the home side's point of view, and it points at the underdog.** The home side is quoted `-Z` and the away side is quoted `+Z`:

| `Z` | Home is quoted | Away is quoted | Favorite |
|---|---|---|---|
| `-35000` | +3.5 | -3.5 | the away team, by 3.5 |
| `0` | pick'em | pick'em | none |
| `+35000` | -3.5 | +3.5 | the home team, by 3.5 |

So at `Z = -35000` the away team is the favorite: it has to win by 4 or more for the away bet to win, and the home bet wins if the home team wins, ties, or loses by 3 or fewer. The API's `currentZDisplay` and `lockedZDisplay` fields are just `Z / 10000`, not a quoted spread.

**Worked example.** Chiefs (home) vs 49ers (away), `lockedZ = -35000`:

- Final spread **+3** (Chiefs win by 3): `30000 > -35000` is true, so the **home** bet wins.
- Final spread **-4** (49ers win by 4): `-40000 > -35000` is false, so the **away** bet wins. (If the 49ers had won by only 3, `-30000 > -35000` is true and the home bet would have won.)

## How Z moves

Z is calculated using the natural log of the pool ratio:

```
Z = initialZ + K * ln(greaterPool / lessEqualPool)
```

Where `K = 50000` controls sensitivity.

When more money flows to the home side, Z rises, which asks more of the home team (and offers the away side a better spread). When more money flows to the away side, Z falls. At equal pools, Z returns exactly to `initialZ`. The movement is algorithmic and transparent: it exists to balance the pools, and it is not a margin taken from you.

**Example.** A market opens at `initialZ = -35000` with both pools at 1 USDC seed, Chiefs (home) vs 49ers (away). A bettor stakes 10 USDC on home. Now `greaterPool = 11` and `lessEqualPool = 1`. The ratio is 11:1, so `ln(11) ≈ 2.398`. New Z = -35000 + (50000 × 2.398) = +84,900. The line has moved from 49ers -3.5 to Chiefs -8.5, a large swing from a single early bet. That is what pulls opposing money to the away side.

## Locked Z

When you place a bet, your `lockedZ` is recorded at that moment and never changes. Your win condition is fixed at that time, and later bettors moving the line do not change whether you win or lose.

**Example.** Chiefs (home) vs 49ers (away):

1. The market opens at `Z = -35000` (49ers -3.5).
2. Heavy betting on home pushes Z to `+10000` (Chiefs -1.0, 49ers +1.0).
3. You bet away at this point, so your `lockedZ = +10000`. You hold the 49ers at +1.0: you win if the 49ers win, tie, or lose by 1.
4. The Chiefs win by 7. `finalSpread * 10000 = 70000`, and `70000 <= 10000` is false, so you lose.
5. Had you bet away at step 1, your `lockedZ = -35000` (49ers -3.5), and `70000 <= -35000` is also false, so the outcome is the same for this final spread. The two bets cover different ranges, though. At `lockedZ = +10000` the away bet wins on any final spread of +1 or lower. At `lockedZ = -35000` it wins only on -4 or lower. Backing the lighter side after the home flow locked a better spread than the opening line offered.

## Pool ratio clamp

The atanh series used to calculate `ln()` degrades above a 19:1 pool ratio. Above this threshold, the ratio is clamped to 19:1 before calculation. This caps maximum single-bet Z movement while preserving direction.

## Z bounds

Z is hard-clamped to ±500.0000 (±5000000 in 4-decimal). This prevents extreme imbalances from pushing Z into ranges where the win condition becomes meaningless: a Z beyond any plausible final spread would make all bets on one side trivially winning or losing. The bounds keep the market mathematically coherent at the edges.

## Reading the quote

Because your bet locks the spread when it lands, getting in early can lock a better spread than the crowd gets later. That is about the spread you lock, not the payout.

`getMarketEV(stake, greaterThan)` returns `currentPayout` and `liquidPayout`. `currentPayout` is the gross return if betting closed with the pools as they are now. `liquidPayout` is the payout when the two pools are balanced. If `currentPayout` is higher, your side holds the smaller share of the money right now. If they are equal, the pools are balanced right now. Either way the payout is set at settlement from the final pool, and later bets can change both numbers before betting closes.

The fee is separate from all of this: a flat 2% of your bet, paid upfront. Nothing else.
