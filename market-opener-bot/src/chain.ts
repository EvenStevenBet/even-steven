import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeEventLog,
  formatUnits,
  formatEther,
  zeroAddress,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { config } from './config.js';

// Fragments transcribed from SportsbookFactory-v1_3.sol. The MarketCreated
// signature was verified to hash-match the contract's declaration exactly.
//
// NOTE: the explicit getMarketByGameId(string) wrapper function that the
// source file declares is NOT callable on the deployed contract (confirmed
// via two independent RPC providers, both revert on that selector, and
// cross-checked against BaseScan's verified ABI). The auto-generated getter
// for the underlying public mapping — marketByGameId — works correctly and
// returns the identical value. We call that instead.
const factoryAbi = parseAbi([
  'function createMarket(string gameId, int256 oracleZ) returns (address)',
  'function marketByGameId(string gameId) view returns (address)',
  'function getOpenMarkets() view returns (address[])',
  'event MarketCreated(address indexed market, string gameId, int256 oracleZ, int256 spreadMax, int256 spreadMin, uint256 feePercent, address indexed creator)',
]);

// Fragments for individual SportsbookMarket contracts (not the factory).
// gameId and bettingOpen are public state variables — Solidity auto-generates
// their getters. closeBetting() is onlyOwner; our wallet must own the market,
// which it does since it's the one that called createMarket().
const marketAbi = parseAbi([
  'function gameId() view returns (string)',
  'function bettingOpen() view returns (bool)',
  'function closeBetting()',
]);

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const account = privateKeyToAccount(config.privateKey);

export const publicClient = createPublicClient({
  chain: base,
  transport: http(config.rpcUrl),
});

export const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(config.rpcUrl),
});

export const botAddress: Address = account.address;

/**
 * Hard gate on wallet identity. Called both at startup and again inside
 * deployMarket(), so the guarantee travels with the dangerous function
 * rather than depending on one entry point remembering to check.
 */
export function verifyProductionWallet(): void {
  if (botAddress.toLowerCase() !== config.productionWallet.toLowerCase()) {
    throw new Error(
      `WALLET MISMATCH — refusing to run. Signing key resolves to ${botAddress}, ` +
        `but PRODUCTION_WALLET is ${config.productionWallet}. Whoever calls createMarket() ` +
        `becomes that market's permanent fee owner. Fix PRIVATE_KEY / PRODUCTION_WALLET.`
    );
  }
}

/** Balances for the preflight log — insufficient ETH is invisible to simulation. */
export async function getBalances(): Promise<{ eth: string; usdc: string }> {
  const [wei, usdc] = await Promise.all([
    publicClient.getBalance({ address: botAddress }),
    publicClient.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [botAddress],
    }),
  ]);
  return { eth: formatEther(wei), usdc: formatUnits(usdc, 6) };
}

/** CONTROL 3 input: live count of currently open markets, straight from the factory. */
export async function countOpenMarkets(): Promise<number> {
  const open = await publicClient.readContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'getOpenMarkets',
  });
  return open.length;
}

/**
 * The factory pulls PROTOCOL_SEED * 2 from the caller via transferFrom, so the
 * caller must have approved it first. Circle USDC on Base rejects exact-amount
 * approvals intermittently, hence max approval (per BUILD-SPEC.md).
 * Normally a genuine one-time cost — the threshold is never reached again.
 */
export async function ensureMaxApproval(dryRun: boolean): Promise<`0x${string}` | 'ok' | 'would-approve'> {
  const allowance = await publicClient.readContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [botAddress, config.factoryAddress],
  });

  const threshold = 2n ** 200n;
  if (allowance >= threshold) return 'ok';
  if (dryRun) return 'would-approve';

  const hash = await walletClient.writeContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [config.factoryAddress, 2n ** 256n - 1n],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: config.receiptTimeoutMs,
  });
  if (receipt.status !== 'success') {
    throw new Error(`USDC approval transaction ${hash} reverted.`);
  }
  return hash;
}

/** Returns the existing market address for a gameId, or null if none exists. */
export async function marketExistsOnChain(gameId: string): Promise<Address | null> {
  const addr = await publicClient.readContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'marketByGameId',
    args: [gameId],
  });
  return addr === zeroAddress ? null : addr;
}

/** CONTROL 3 support: the actual open-market addresses, not just a count. */
export async function getOpenMarketAddresses(): Promise<readonly Address[]> {
  return publicClient.readContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'getOpenMarkets',
  });
}

/** Reads the gameId a given market was created for — used to match on-chain
 * open markets back to their row in the sheet, so we know their kickoff time. */
export async function getMarketGameId(marketAddress: Address): Promise<string> {
  return publicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'gameId',
  });
}

/** Whether a specific market is still accepting bets right now. */
export async function isBettingOpen(marketAddress: Address): Promise<boolean> {
  return publicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'bettingOpen',
  });
}

/** Dry-run rehearsal for closing betting — proves the call would succeed. */
export async function simulateCloseBetting(marketAddress: Address): Promise<void> {
  verifyProductionWallet();
  await publicClient.simulateContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'closeBetting',
    account: botAddress,
  });
}

/**
 * Closes betting on a single market whose game has started. onlyOwner on the
 * contract — our wallet owns every market it created, so this always targets
 * a market this same bot (or a manual createMarket call from this wallet)
 * opened. Never call this on a market we don't own.
 */
export async function closeMarketBetting(
  marketAddress: Address
): Promise<{ txHash: `0x${string}` }> {
  verifyProductionWallet();

  await publicClient.simulateContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'closeBetting',
    account: botAddress,
  });

  const hash = await walletClient.writeContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'closeBetting',
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: config.receiptTimeoutMs,
  });

  if (receipt.status !== 'success') {
    throw new Error(
      `closeBetting transaction ${hash} was mined but REVERTED on market ${marketAddress}.`
    );
  }

  return { txHash: hash };
}

/** Dry-run rehearsal: proves the call would succeed without broadcasting. */
export async function simulateDeploy(gameId: string): Promise<void> {
  verifyProductionWallet();
  await publicClient.simulateContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'createMarket',
    args: [gameId, 0n],
    account: botAddress,
  });
}

/**
 * Deploys a market with a fixed neutral opening line.
 *
 * oracleZ is ALWAYS 0. This is deliberate protocol design — currentZ moves as
 * bets arrive and each bettor locks the line at their own bet time, so an
 * opening line carries little weight. Early-mover advantage is the intended
 * cold-start liquidity incentive. Never add odds-fetching here.
 */
export async function deployMarket(
  gameId: string
): Promise<{ marketAddress: Address; txHash: `0x${string}` }> {
  // Re-checked here so the guarantee is attached to the dangerous call itself.
  verifyProductionWallet();

  const oracleZ = 0n;

  // Catches reverts (duplicate gameId, insufficient USDC or allowance) before
  // spending gas. Note: does NOT catch insufficient ETH for gas.
  await publicClient.simulateContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'createMarket',
    args: [gameId, oracleZ],
    account: botAddress,
  });

  const hash = await walletClient.writeContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: 'createMarket',
    args: [gameId, oracleZ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: config.receiptTimeoutMs,
  });

  if (receipt.status !== 'success') {
    throw new Error(
      `Transaction ${hash} was mined but REVERTED. No market was created. ` +
        `Check for a duplicate gameId or a competing run before retrying.`
    );
  }

  // createMarket's return value isn't recoverable from a mined tx — read the
  // authoritative address off the MarketCreated event instead.
  for (const entry of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: factoryAbi,
        data: entry.data,
        topics: entry.topics,
        eventName: 'MarketCreated',
      });
      if (decoded.eventName === 'MarketCreated') {
        return { marketAddress: decoded.args.market, txHash: hash };
      }
    } catch {
      // Unrelated event in the same receipt (e.g. USDC Transfer) — skip.
    }
  }

  throw new Error(
    `Transaction ${hash} succeeded but no MarketCreated event was found. ` +
      `Verify on-chain manually before retrying — the market may exist.`
  );
}
