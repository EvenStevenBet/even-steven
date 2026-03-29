# Even Steven

**Sports betting where the house takes nothing.**

Even Steven is a parimutuel sports betting protocol on Base blockchain. When you win, you split what the losers put in. The protocol takes a flat 2% fee. That's it. No spread. No house edge. No one betting against you.

---

## How it works

Pick a game. Decide which way the spread goes. Put in your USDC. If you're right, you split the losing side's money with everyone else who was right.

The protocol seeds each market with a small amount on each side to start the pool. After that, it's purely bettors vs bettors.

**Example:**

Chiefs vs 49ers. Opening line: Chiefs -3.5.

- You bet $10 that the Chiefs cover (win by more than 3.5)
- Others bet $10 that they don't
- Chiefs win by 7
- You split the $10 from the losing side, minus 2% fee
- You walk away with roughly $19.60

No sportsbook took a cut on the spread. No juice. Just 2%.

---

## The Z line

Every market has a dynamic Z line — the point at which the bet splits into "greater than" vs "less than or equal to." The Z line starts at the opening consensus line and moves as bets come in.

**Why this matters for you:**

If everyone is betting one way, the Z line moves against them and creates better odds for the other side. Bet early on the unpopular side and you lock in a favorable position. Bet late on the crowded side and your payout gets diluted.

Your locked Z is recorded when you place your bet and never changes. Future bettors don't affect your position.

---

## What it costs

**2% of the pot.** That's the entire fee. Nothing else.

A standard sportsbook charges roughly 4.5% vig on every bet (-110 line). Even Steven charges 2% with no spread on top. On a balanced market, you're betting roughly -104 — significantly better than any licensed book.

| | Even Steven | Standard Sportsbook | Polymarket |
|---|---|---|---|
| Protocol fee | 2% | ~4.5% | 0.1-1.8% |
| Spread cost | None | Built in | Order book spread |
| **Total cost** | **2%** | **~4.5%** | **~0.5-2.5%** |

---

## Trustless settlement

Game results are verified through UMA's Optimistic Oracle — a decentralized dispute system used across DeFi. After a game ends, anyone submits the final spread with a bond. If no one disputes it within 2 hours, the market settles automatically. No one person controls the outcome.

If a market is ever abandoned (owner disappears, game never settles), anyone can trigger a full refund after 7 days. Your money is never stuck.

---

## Built on Base

Even Steven runs on Base — Coinbase's Ethereum L2. Fast transactions, low gas costs, and USDC as the native betting currency. No wrapping, no bridging. Deposit USDC, bet USDC, withdraw USDC.

---

## Status

Currently in testnet on Base Sepolia. Mainnet coming soon.

Smart contracts audited March 2026. All critical and high findings resolved.

---

## For developers and agents

See [AGENTS.md](./AGENTS.md) for the full technical integration guide — contract addresses, ABI reference, code examples, and event subscriptions.

---

*Even Steven is an experimental protocol. Bet only what you can afford to lose. Smart contracts are not infallible.*
