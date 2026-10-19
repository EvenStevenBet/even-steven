# Even Steven skill for Bankr (developer README)

Source of truth for the Bankr skill. We mirror this folder to `BankrBot/skills/even-steven` by pull
request later. **This README is for developers and partners. It is not part of the skill's
reply templates: bettor-facing replies (SKILL.md and the script output) carry no builder-code or
points copy.**

## What it does

Non-custodial betting from a Bankr wallet. The wallet signs a USDC `ReceiveWithAuthorization`
through Bankr's `POST /wallet/sign`; Even Steven's relay (`POST /api/bet`) submits it and pays the
gas; USDC moves from the wallet straight to the market. The skill never calls `/wallet/submit`,
`/wallet/transfer` or `/wallet/swap`.

Commands: `markets`, `odds`, `bet --prepare` / `bet --confirm`, `status`, `claim`. See [SKILL.md](SKILL.md).

## Install from this repo

Tell your Bankr agent, for example in a post to @bankrbot:

> install the even-steven skill from https://github.com/EvenStevenBet/even-steven/tree/main/integrations/bankr/even-steven

Then, in the skill folder: `npm install` (Node 20+). Setup, key permissions and funding are in
[SKILL.md](SKILL.md). The Bankr key needs Wallet API on, Read Only off and Trusted Addresses empty.

## Builder codes

A builder code earns 30% of the 2% fee on every bet routed through it, paid weekly.

To ask for a builder code, email evenstevenbet@gmail.com. Only Jeff approves builders, and an
unapproved code earns nothing.

The script sends no `ref` by default. A single optional setting, `ES_REF`, adds one constant `ref`
to every relayed bet from that install. It is unset by default and is for an approved builder's own
channel. The relay ignores an unknown or malformed value and still places the bet.

Every transaction the relay sends carries Even Steven's own Base builder code `bc_ncytgilx` as an
ERC-8021 schema-0 calldata suffix, for Base's attribution. It earns partners nothing and does not
change the bet.

## Points

Points are a scoreboard. Bettors earn 100 points per USDC staked, win or lose; a bet that arrives
with a wallet-address ref earns that wallet 50 points per USDC. Leaderboard at evensteven.bet/points.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BANKR_CONFIG` | `~/.bankr/config.json` | Bankr config holding `apiKey`; read the same way as the AgenticBets skill, never printed or written |
| `ES_MAX_STAKE` | `25` | Maximum stake in USDC (the minimum is 1) |
| `ES_REF` | unset | Optional constant `ref`, see above |
| `ES_STATE_DIR` | `~/.bankr/even-steven` | Where prepared bets are stored (mode 0600) |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Read-only RPC |

Only `api.bankr.bot` and `evensteven.bet` are ever called; the script refuses any other host.

## Tests

```bash
npm install
npm test                       # unit tests: mocked Bankr API, relay and RPC, throwaway key, no network
```

Fork test (Base mainnet fork, real Circle USDC, no keys): start the fork node from
`scripts/fork-tests` (`npx hardhat node`, needs `ALCHEMY_RPC_URL`, see that README), then
`node scripts/fork.test.mjs` here. It drives the script's real code path with a mock Bankr signer
and a fork-side relay shim that submits the script's exact payload to `placeBetFor` and
`placeBetForWithSignature` on a v1.11 market.

Read-only live check (no key needed for these two, bets and x402 payments are never made):

```bash
BANKR_CONFIG=/path/to/any.json node scripts/even-steven.mjs markets --all
BANKR_CONFIG=/path/to/any.json node scripts/even-steven.mjs odds "<game>" --all
```

The first live bet is described in [TESTING.md](TESTING.md).
