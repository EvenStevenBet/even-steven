# First live test: one 1 USDC bet (Jeff runs this; Code does not)

Nothing here is run by Code. It moves 1.02 USDC from the Bankr wallet, so Jeff runs it.

## Before

1. The Bankr key: Wallet API on, Agent API on, Read Only off, Trusted Addresses empty.
2. The Bankr wallet holds at least **1.02 USDC** on Base. It needs no ETH.
3. The relay (`0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed`) has ETH above its minimum (0.002 ETH).
4. An open market exists: `node scripts/even-steven.bundle.mjs markets`. If none is open, wait for one. Do not bet on a closed game.
5. `export ES_MAX_STAKE=1` for this shell, so the script itself refuses anything larger.
6. Note the Bankr wallet's USDC balance and the relay's USDC balance (the relay should be 0).

## Steps

1. `node scripts/even-steven.bundle.mjs markets` and `odds "<game>" --stake 1`. Both are free chain reads. Record the line.
2. `node scripts/even-steven.bundle.mjs bet --prepare "<game>" <home|away|team> 1`. Check the text: even money, the line (it locks when the bet lands), flat 2% fee on the stake paid upfront, total **1.02 USDC**, "Reply confirm." Note the intent id.
3. Reply `confirm`, then `node scripts/even-steven.bundle.mjs bet --confirm <intent-id>`.
4. Record the output: "Bet placed", the locked line, the bet id, the transaction link.
5. `node scripts/even-steven.bundle.mjs status "<game>"` and confirm the bet appears with the same locked line.
6. Unset `ES_MAX_STAKE`.

## Success criteria (all must hold)

| # | Check | How |
|---|---|---|
| 1 | The relay answered 200 and the script printed "Bet placed" | script output |
| 2 | `BetPlaced.bettor` is the Bankr wallet | BaseScan: the tx's logs, `BetPlaced(bettor, betId, stake, fee, greaterThan, lockedZ)`; or `status` |
| 3 | The calldata ends with the Even Steven builder-code suffix | BaseScan: Input Data, view original. It must end with `62635f6e63797467696c78` `0b` `00` `80218021802180218021802180218021` (that is `bc_ncytgilx`, length 11, schema 0, the ERC-8021 marker) |
| 4 | No USDC touched the relay | BaseScan: the tx's token transfers show only wallet to market (1.02 USDC) and market to owner (the 0.02 USDC fee); no transfer to or from `0x8a3e…ed`; relay USDC balance still 0 |
| 5 | The wallet paid exactly stake + fee | wallet balance fell by exactly 1.02 USDC |
| 6 | The locked line equals the line shown at prepare (or a later line if bets landed in between) | script output vs `markets` |
| 7 | The signature was 65 bytes and the relay used `placeBetFor` | Jeff's probe result for this wallet; the tx is a `placeBetFor` call |

## Record (paste back to the Integrations Lead)

- Date and time (UTC), market address and gameId, side, stake.
- Bankr wallet address; wallet and relay USDC balances before and after.
- The full `--prepare` and `--confirm` output (it contains no secret).
- Transaction hash, block, bet id, locked line.
- The tail of the transaction's input data (last 80 hex characters).
- The transfer list from BaseScan.
- Pass or fail for each row above.

## If it fails

Paste the script's output. It prints the relay's error with a plain explanation and the action. Do not re-run `--confirm` for a bet that may have landed without checking `status` first; the script does this itself, and it never signs a second authorization for the same prepared bet.
- A 403 from Bankr means the key restricts typed-data signing (Trusted Addresses or another restriction).
- `RelayUnderfunded` means top up the relay's ETH.
