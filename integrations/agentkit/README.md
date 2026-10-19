# Even Steven action provider for AgentKit (local package, not published)

Back either side at even money, lock a better spread by betting early, and pay a flat 2% of your bet. Nothing else.
This is a TypeScript `ActionProvider` for `@coinbase/agentkit` 0.10.4. It never sends a transaction and never touches a private key.

## Actions

`list_even_steven_markets`, `get_even_steven_quote` (free chain reads), `prepare_even_steven_bet` (read only), `confirm_even_steven_bet`,
`get_even_steven_bets`, `claim_even_steven_payout`.

Betting is two steps. `confirm_even_steven_bet` asks the wallet provider to sign one EIP-712 typed data (a USDC
`ReceiveWithAuthorization`) with `signTypedData`, verifies the signature recovers to the wallet, and posts it to Even Steven's relay,
which pays the gas. USDC moves from the wallet straight to the market. The action description tells the model to call it only after
the user replies "confirm" to the exact prepared bet. An in-process state machine claims the intent (pending to signing) before it
signs, so a concurrent or repeated confirm cannot sign twice, and it follows the relay's retry rule (identical resend, never re-sign).

Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.

`supportsNetwork` is true only for `base-mainnet`. Stake is 1 to 25 USDC (`maxStakeUsdc` changes the cap).

```ts
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { evenStevenActionProvider } from "@evensteven/agentkit";
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [evenStevenActionProvider()] });
```

## Tests

```bash
npm install
npm test            # builds, then vitest: 15 tests with a stand-in wallet provider and mocked chain and relay
npm run test:fork   # Base fork: real USDC, v1.11 markets, relay shim (start `npx hardhat node` in scripts/fork-tests first)
npm run sync        # re-copy src/shared.ts and src/core.ts from integrations/mcp/src
```

## If this is ever proposed to coinbase/agentkit (nothing has been done)

- Their CONTRIBUTING requires **signed commits**, a filled-in PR template, a changeset (`pnpm run changeset`), a README in the
  provider folder, unit tests next to the provider, and **a manual end-to-end transcript** from one of the example chatbots on
  the network used (PR template "Tests" section). No such transcript exists yet, and none can be made without a funded wallet.
- The contribution would be licensed under their Apache-2.0 license (this repo is MIT).
- Providers there live in `typescript/agentkit/src/action-providers/<name>/` and use the `generate-action-provider` script.
- AgentKit's `@CreateAction` wrapper posts an analytics event (action name, wallet address, network) to cca-lite.coinbase.com on every
  action. That is AgentKit's behavior, not this provider's; the tests stub it and assert it is the only non-relay call.
- `src/shared.ts` and `src/core.ts` are generated copies (type checking off) so the package stands alone; a real PR would turn
  them into typed source.
