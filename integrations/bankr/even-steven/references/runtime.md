# Where this skill runs, and what it writes

Findings from Bankr's docs (docs.bankr.bot, skills and file storage pages) and from how existing skills in BankrBot/skills run
their scripts. Items marked **unverified** are not stated in the docs and need a test on a real Bankr agent.

## What the docs say

- A skill is a `SKILL.md` plus `references/` and other files. On install, Bankr copies the other files (scripts, data) into the
  agent's file storage under `/skills/<skill-name>/`, up to 2 MB per file and 5 MB per skill. `references/` is capped at 30 files of
  100 KB each, `SKILL.md` at 1 MB. **Dependencies are not installed from the repo.**
- The agent has an `execute_cli` sandbox "to run scripts, generate images, compile code, or install CLI tools on the fly". The
  `twitter-agent` skill runs Node through it with a pinned npm package (`twitter-api-v2@1.17.2`), and `requires.packages` in
  frontmatter makes Bankr install pinned npm packages before a run. So Node scripts and npm packages are supported. `requires.bins`
  does not install anything, and language runtimes such as Python are not installed.
- Credentials can be host-managed: the key may be in `BANKR_API_KEY` (a real key or a stand-in) or attached by an egress proxy
  at the network layer, in which case no key is visible to the process (BankrBot/skills `bankr/references/safety.md`). The script
  therefore reads the config file, then `BANKR_API_KEY`, then sends no header at all (never an empty `X-API-Key`).
- Secrets for scripts can be stored as encrypted per-wallet environment variables that a skill or `execute_cli` script reads.
- MCP servers are not used on X or Farcaster. The docs do not list skills or `execute_cli` as unavailable there.

## What the script writes

Only the pending-bet store: `~/.bankr/even-steven/intents/<id>.json` (mode 0600, no key, no signature until signing) plus a
short-lived `<id>.lock`. `ES_STATE_DIR` moves it. Nothing else is written, and the Bankr key is never written.

## Unverified, to test on a real agent

1. Whether the `execute_cli` sandbox allows outbound HTTPS to `api.bankr.bot`, `evensteven.bet` and `mainnet.base.org`.
2. Whether the sandbox filesystem persists between two `execute_cli` calls (prepare, then confirm in a later turn). If it does
   not, the pending-bet store is lost between the two steps.
3. Whether the sandbox exposes `~/.bankr/config.json`, `BANKR_API_KEY`, or only the egress proxy.
4. Whether skills run on the X and Farcaster surfaces, and any reply-length limit there. The docs state no reply-length limit;
   X's own post limit applies (unverified). `--compact` keeps replies short either way.

## If the sandbox does not persist files: a stateless intent store (proposal, needs a decision)

The confirmation text already carries an id. Make the id a self-contained token and derive the salt from it:

- `prepare` prints `id = base64url(JSON{market, side, stake, fee, wallet, expiresAt}) + "." + HMAC(secret, payload)` where `secret`
  is derived from the Bankr key (or a per-wallet environment variable). `confirm <id>` verifies the HMAC and the 5-minute expiry
  and re-validates everything as today.
- The authorization's salt is `keccak256(abi.encode(id, wallet))` instead of a random value. Every confirm of the same id then
  produces the same EIP-3009 nonce, and USDC lets a nonce be used once, so a double confirm, or a rerun after a crash, can
  place at most one bet even with no stored state. The relay also locks by bettor and nonce.
- Trade-offs: the crash rule ("abandon, require a new prepare") becomes "a rerun re-signs the same nonce, which is safe";
  `validBefore` still differs per signature, which is fine because the nonce is what is single-use. The salt is no longer a fresh
  random value per signature (it is fresh per prepared bet), which changes the "fresh random 32-byte salt per bet" rule.

Decision needed from the Integrations Lead: keep the file store (works wherever the sandbox persists files) or switch to the
stateless token (works anywhere, but changes the salt rule).
