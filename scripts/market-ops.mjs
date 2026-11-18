#!/usr/bin/env node
/**
 * Owner operations for Factory v1.6 and its markets, with signing that never passes through Claude.
 *
 *   node scripts/market-ops.mjs status [--market 0x… | --game-id <id>]
 *   node scripts/market-ops.mjs open-market --game-id <id> --z <fixed-point> --seed <USDC/side> [--confirm]
 *   node scripts/market-ops.mjs close-betting       (--market | --game-id) [--confirm]
 *   node scripts/market-ops.mjs trigger-refund      (--market | --game-id) [--confirm]
 *   node scripts/market-ops.mjs approve-bond        (--market | --game-id) [--confirm]
 *   node scripts/market-ops.mjs request-settlement  (--market | --game-id) --spread <int> [--confirm]
 *   node scripts/market-ops.mjs execute-settlement  (--market | --game-id) [--confirm]
 *   node scripts/market-ops.mjs cancel-market       (--market | --game-id) [--confirm]
 *   node scripts/market-ops.mjs pause | unpause     (--market | --game-id) [--confirm]
 *   (old names `state` and `close` still work as aliases)
 *
 * Every command SIMULATES by default and sends only with --confirm. Simulation and status never load the
 * key. A --confirm run reads PRIVATE_KEY (and PRODUCTION_WALLET if present) from ~/.even-steven/bot.env
 * INSIDE this process into local variables: not argv, not process.env, no child process, never printed.
 * It refuses unless the key derives the production wallet AND the factory owner.
 *
 * Optional: MAINNET_RPC (comma-free single URL) is tried before the public Base RPCs.
 * Deliberately not here: moving USDC out of any wallet or market, ownership transfers, operator changes,
 * fee/identifier changes, custom spread bounds, renouncing. See docs in the PR.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import { run, makeClients, makeLoadSigner } from './lib/market-ops-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const rpcs = [process.env.MAINNET_RPC, 'https://mainnet.base.org', 'https://base-rpc.publicnode.com'].filter(Boolean)
  const { pub, makeWallet } = makeClients(rpcs)
  process.exitCode = await run(process.argv.slice(2), {
    pub, makeWallet,
    loadSigner: makeLoadSigner({ readFile: p => fs.readFileSync(p), envPath: path.join(os.homedir(), '.even-steven', 'bot.env'), parseEnv: dotenv.parse }),
    readCsv: () => fs.readFileSync(path.resolve(HERE, '../data/markets.csv'), 'utf8'),
  })
}
