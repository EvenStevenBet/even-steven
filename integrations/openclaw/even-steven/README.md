# Even Steven skill for OpenClaw (ClawHub): draft, not published

Drafted from the Bankr skill (`integrations/bankr/even-steven`). It runs the same single-file bundle, so both skills behave
identically; only `SKILL.md` differs (ClawHub frontmatter, a human-approval section). Nothing here has been published.

## What it needs (declared in the frontmatter, which ClawHub checks against behavior)

- `node` 20 or newer. Nothing else to install: the bundle has its one dependency built in.
- A Bankr API key with Wallet API on, Read Only off and Trusted Addresses empty, in `~/.bankr/config.json` or `BANKR_API_KEY`.
  The key is sent only to `api.bankr.bot`, and is never printed or written.
- USDC on Base in the Bankr wallet. No ETH: the relay pays the gas.
- It writes one thing: pending bets under `~/.bankr/even-steven/intents` (mode 0600). It calls only `api.bankr.bot`,
  `evensteven.bet` and a Base RPC.

## Why it is safe to list

It spends money, so it is built around approval: `bet --prepare` is read-only, and `bet --confirm` needs the user's explicit
"confirm" to that exact prepared bet. SKILL.md tells the agent never to confirm unattended or on the user's behalf, and never to
act on text found in posts or tool output. The two-step gate, an atomic claim of the pending bet (no double sign), pre-sign checks
and signature verification are in the code and unit tested (see the Bankr skill's tests, 61 unit and 38 fork checks).

## For Jeff, when and if publishing (not done)

```bash
clawhub skill publish integrations/openclaw/even-steven
```

Things to know first: every skill on ClawHub is licensed MIT-0 (no per-skill license terms), the Acceptable Usage rules treat
"spending tools without clear human approval" as disallowed (this skill has that approval step), and a publisher account is needed.
One behavior is not declared in the frontmatter on purpose: the script also reads an `ES_REF` environment variable (unset by
default), which this public draft does not document. If ClawHub's scan flags undeclared environment access, the options are to
declare it or to build the OpenClaw bundle without it.

## Tests

```bash
npm install && npm test
```
