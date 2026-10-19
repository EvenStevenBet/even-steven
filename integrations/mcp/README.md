# Even Steven MCP server

A remote MCP server for Even Steven. Back either side at even money, lock a better spread by betting early, and pay a flat
2% of your bet. **It holds no keys and signs nothing.** The client's own wallet signs, and USDC moves from the bettor straight
to the market. Nothing in this folder is deployed or registered.

## Tools

| Tool | What it does |
|---|---|
| `list_markets` | Open games: teams, the line, pools, whether betting is open. Free chain read. |
| `get_quote` | The line and the contract's own gross quote for both sides. Free chain read; never a paid call. |
| `prepare_bet` | Step 1. Returns the confirmation text, the typed data (a USDC `ReceiveWithAuthorization`) and a relay payload. Nothing is signed or sent. |
| `submit_bet` | Step 2. Takes the payload plus the wallet's signature, re-derives every field, verifies the signature, then posts to the relay, which pays the gas. |
| `get_status` | A wallet's bets on a game with locked lines. Free chain read. |
| `claim` | Collects a payout through the relay. Nothing to sign. |

Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.

## What `submit_bet` checks before anything is posted

Only the nine relay fields are accepted (no extras). The market must be one Factory v1.6 created and must be open; the stake is
1 to 25 USDC (`ES_MAX_STAKE` changes the cap); `validAfter` is 0 and `validBefore` is 30 seconds to about 11 minutes away; the
nonce equals `keccak256(abi.encode(salt, greaterThan))`; the value is derived from the stake and the market's own `FEE_PERCENT()`;
and the signature must recover to the bettor over the typed data the server derives from the payload (`ecrecover` for 65 bytes,
ERC-1271 `isValidSignature` for a contract wallet). A bad signature never reaches the relay, so it cannot cost anyone a relay strike.

## Running

```bash
npm install
npm test                      # unit tests (mocked chain, relay and clock) and the HTTP protocol path
npm run serve                 # local only: http://127.0.0.1:8787/mcp (read-only chain access plus the public relay)
```

Fork test (Base fork, real USDC, throwaway keys): start `npx hardhat node` in `scripts/fork-tests`, then
`node test/fork.fork.mjs` here. It runs the real HTTP handler, a client that signs the prepared typed data, and a relay shim that
submits the exact payload, for an EOA, an ERC-1271 wallet, tampered payloads and a replay.

## Hosting notes (not done)

`handle(request, deps)` in `src/server.mjs` is stateless and uses only Request and Response, so it mounts in a Next.js route, a
Worker or a plain Node server. The relay rate-limits and strikes per IP, so a host on a shared egress IP would share one budget
across all users. The handler forwards the caller's `x-forwarded-for`; the relay would need to trust the host that sets it, or
the handler should be mounted in the same deployment as the relay. `server.json` is the Registry listing for
`io.github.EvenStevenBet/even-steven` (the remote URL is the intended one and is not live). Publishing needs a GitHub org Owner,
and the Registry's Terms prohibit promoting or facilitating unlawful online gambling.
