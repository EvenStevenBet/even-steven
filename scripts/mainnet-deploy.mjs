#!/usr/bin/env node
/**
 * Base MAINNET deploy for SportsbookMarket v1.11 / MarketDeployer v1.1 /
 * SportsbookFactory v1.6 — the v3 release. Executes v1.11-mainnet-plan.md exactly.
 *
 * NOT YET RUN. v1.10/v1.5 is what is live on mainnet; this script now targets v3 and
 * will refuse to proceed unless the three contracts compile to 19,668 / 8,085 / 18,270
 * at optimizer runs=200. The v1.10 deploy it previously performed is recorded in
 * v1.10-mainnet-plan.md and in scripts/verification/ (compiled at runs=1).
 *
 *   node mainnet-deploy.mjs preflight     # read-only. No transactions. Run this first.
 *   node mainnet-deploy.mjs deploy        # plan steps 1-6 (deploy + wiring + approval)
 *   node mainnet-deploy.mjs open-market   # plan step 7. Requires GAME_ID + ORACLE_Z + --confirm
 *   node mainnet-deploy.mjs verify        # post-deploy checks, read-only
 *
 * env (repo/scripts/.env, gitignored — never commit):
 *   MAINNET_PRIVATE_KEY   the deploying key. Must derive MAINNET_DEPLOY_WALLET exactly.
 *   MAINNET_DEPLOY_WALLET the address this deploy must come from. REQUIRED, no default:
 *                         an unset value aborts rather than deploying from whatever key
 *                         happens to be present. v1.5 went out from 0x6cF0A0b5...603B,
 *                         which still owns Factory v1.5; v3 uses a fresh wallet.
 *                         Resolved from $EVEN_STEVEN_ENV, then ~/.even-steven/.env, then
 *                         scripts/.env — key material should not sit in an iCloud-synced
 *                         folder, which is what ~/Desktop is.
 *   MAINNET_RPC           optional, defaults to https://mainnet.base.org
 *   GAME_ID / ORACLE_Z    step 7 only. ORACLE_Z is 4-decimal fixed point (-35000 = -3.5).
 *
 * Aborts rather than continues on: wrong wallet, compiled size mismatch, identifier not
 * whitelisted, deployer wiring mismatch, or settlementIdentifier != ASSERT_TRUTH2.
 * Every abort happens BEFORE the next transaction is sent.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import solc from 'solc'
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, stringToHex,
         parseEventLogs, formatUnits, formatEther, getAddress, padHex, toEventSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { loadEnv, envSearchList } from './env-resolve.mjs'

const HERE      = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS = path.resolve(HERE, '../contracts')
const STATE     = path.resolve(HERE, 'mainnet-deploy-state.json')
// Same env resolution as every other script here: $EVEN_STEVEN_ENV, then
// ~/.even-steven/.env, then scripts/.env. Key material must not sit under
// ~/Desktop, which is iCloud-synced.
const ENVFILE   = loadEnv(HERE) || ('(none found; looked in:\n    ' + envSearchList(HERE) + ')')

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OO   = '0x2aBf1Bd76655de80eDB3086114315Eec75AF500c'
/**
 * The address this script is allowed to deploy from. REQUIRED — there is no default,
 * so a missing value aborts rather than letting a deploy go out from whatever key
 * happens to be in the env file.
 *
 * It was hardcoded to 0x6cF0A0b5…603B, the wallet that deployed v1.5 and still owns
 * Factory v1.5 and the Bills/Lions market. v3 deploys from a fresh key, so the
 * expected address is now stated explicitly per deploy instead of baked in.
 */
const PROD = (process.env.MAINNET_DEPLOY_WALLET || '').trim()
/**
 * RPC selection, in order: MAINNET_RPC > ALCHEMY_RPC_URL > ALCHEMY_KEY > public.
 *
 * The public endpoints are a last resort, not a default. During the Bills/Lions
 * settlement run on 2026-09-17 all four failed in different ways:
 *   base-rpc.publicnode.com  refuses eth_getTransactionReceipt as an "archive
 *                            request" — the write lands, then the script dies
 *                            reading its own receipt and reports false failure
 *   mainnet.base.org         "over rate limit" mid-run; eth_getLogs capped at 2000
 *   base.drpc.org            "Unknown block" on a pinned read moments after a
 *                            confirmed transaction
 *   1rpc.io/base             eth_getLogs capped at 50 blocks
 *
 * NOTE on eth_getLogs: the project's Alchemy account is on the Free tier, which
 * caps getLogs at a 10-BLOCK range — narrower than every public endpoint above.
 * Nothing in these scripts or the bot uses getLogs (events are decoded from
 * transaction receipts), so this does not bite here, but do not add log scanning
 * against this endpoint without checking the tier first.
 */
function resolveRpc() {
  if (process.env.MAINNET_RPC) return process.env.MAINNET_RPC
  if (process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL
  if (process.env.ALCHEMY_KEY) return 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_KEY
  console.warn('  WARNING: no ALCHEMY_RPC_URL / ALCHEMY_KEY set — falling back to a public RPC.')
  console.warn('  Public endpoints failed four different ways during the v1.10 launch; see resolveRpc().')
  return 'https://mainnet.base.org'
}
const RPC  = resolveRpc()
const LAUNCH_SEED = 1000000n                       // 1 USDC/side, Option D
// v1.11 / v1.1 / v1.6 at solc 0.8.20+commit.a1b79de6, optimizer ON, runs=200, shanghai.
// Measured at Gate 1c and reproduced by scripts/verification/v1.11/standard-json-input.json.
// At runs=1 the same sources give 18022 / 19439 / 8048 — if you see those, the runs
// setting is wrong and this gate will (correctly) abort the deploy.
const EXPECTED = { MarketDeployer: 19668, SportsbookFactory: 8085, SportsbookMarket: 18270 }
const MARKET_CREATED_TOPIC0 = '0xb0986a0038b9a2afc3b9dc7e400ddeb31ff547737cf738390752e5e6eba767a5'
const b32 = s => padHex(stringToHex(s), { size: 32, dir: 'right' })
const f   = v => formatUnits(v, 6)

const die = (msg) => { console.error('\n*** ABORT: ' + msg + '\n*** No further transactions will be sent.'); process.exit(1) }
const onErr = e => {
  console.error('\n!! ERROR: ' + ((e.shortMessage || e.message || '').split('\n')[0]))
  if (e.details) console.error('   details: ' + e.details)
  console.error('   Nothing further sent. Re-read state before retrying: ' + STATE)
  process.exit(1)
}
process.on('unhandledRejection', onErr); process.on('uncaughtException', onErr)

const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 120000 }) })

function account() {
  const k = (process.env.MAINNET_PRIVATE_KEY || '').trim()
  if (!k) die('MAINNET_PRIVATE_KEY is not set in ' + ENVFILE)
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die('MAINNET_PRIVATE_KEY must be 0x + 64 hex (got length ' + k.length + ')')
  if (!PROD) die('MAINNET_DEPLOY_WALLET is not set. State the address this deploy must come ' +
                 'from (in ' + ENVFILE + ' or the environment) — this script will not deploy ' +
                 'from an unstated address.')
  if (!/^0x[0-9a-fA-F]{40}$/.test(PROD)) die('MAINNET_DEPLOY_WALLET must be 0x + 40 hex (got "' + PROD + '")')
  const a = privateKeyToAccount(k)
  if (getAddress(a.address) !== getAddress(PROD))
    die('key derives ' + a.address + ' but MAINNET_DEPLOY_WALLET is ' + getAddress(PROD) +
        '. Refusing to deploy from another address.')
  return a
}
const wallet = () => createWalletClient({ account: account(), chain: base, transport: http(RPC, { timeout: 120000 }) })

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
])
const ooAbi     = parseAbi(['function finder() view returns (address)', 'function getMinimumBond(address) view returns (uint256)'])
const finderAbi = parseAbi(['function getImplementationAddress(bytes32) view returns (address)'])
const iwAbi     = parseAbi(['function isIdentifierSupported(bytes32) view returns (bool)'])

/** R6-10: public RPCs load-balance; wait for a write to be visible before depending on it. */
async function untilState(label, read, want, tries = 40) {
  let last, lastErr
  for (let i = 0; i < tries; i++) {
    try { last = await read(); lastErr = undefined; if (want(last)) return last }
    catch (e) { lastErr = (e.shortMessage || e.message || '').split('\n')[0] }
    await new Promise(r => setTimeout(r, 2000))
  }
  die('state never became visible after ' + tries * 2 + 's: ' + label +
      (lastErr ? ' (read threw: ' + lastErr + ')' : ' (last: ' + String(last) + ')'))
}
async function readRetry(fn, label, tries = 5) {
  let last
  for (let i = 0; i < tries; i++) { try { return await fn() } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000)) } }
  die('read failed after ' + tries + ' attempts (' + label + '): ' + ((last?.shortMessage || last?.message || '').split('\n')[0]))
}

function compile() {
  const files = ['SportsbookMarket-v1_11.sol', 'MarketDeployer-v1_1.sol', 'SportsbookFactory-v1_6.sol']
  const sources = {}
  for (const fl of files) sources[fl] = { content: fs.readFileSync(path.join(CONTRACTS, fl), 'utf8') }
  const ozRoots = [path.resolve(HERE, 'node_modules/@openzeppelin/contracts'),
                   path.resolve(HERE, '../node_modules/@openzeppelin/contracts'),
                   path.resolve(process.cwd(), 'node_modules/@openzeppelin/contracts')]
  const findImport = imp => {
    const m = imp.match(/^@openzeppelin\/contracts@?[\d.]*\/(.*)$/)
    const cands = m ? ozRoots.map(r => path.join(r, m[1])) : [path.join(CONTRACTS, imp.replace(/^\.\//, ''))]
    for (const p of cands) { try { return { contents: fs.readFileSync(p, 'utf8') } } catch (e) {} }
    return { error: 'not found: ' + imp }
  }
  if (!solc.version().startsWith('0.8.20+commit.a1b79de6'))
    die('solc is ' + solc.version() + ', plan requires 0.8.20+commit.a1b79de6')
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } } }
  }), { import: findImport }))
  const errs = (out.errors || []).filter(e => e.severity === 'error')
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); die('compilation failed') }
  const arts = {}
  for (const fl of Object.keys(out.contracts))
    for (const [n, c] of Object.entries(out.contracts[fl]))
      if (c.evm.bytecode.object)
        arts[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, size: c.evm.deployedBytecode.object.length / 2 }

  console.log('  solc ' + solc.version() + ', optimizer on runs=200, EVM shanghai')
  let ok = true
  for (const [n, want] of Object.entries(EXPECTED)) {
    const got = arts[n]?.size
    const match = got === want
    ok = ok && match
    console.log('    ' + n.padEnd(20) + String(got).padStart(6) + ' bytes  expected ' + want +
                (match ? '  OK' : '  *** MISMATCH ***') + (got > 24576 ? '  *** OVER EIP-170 ***' : ''))
  }
  if (!ok) die('compiled sizes do not match the audited build. Compiler settings are wrong — do not deploy.')
  return arts
}

async function identifierWhitelisted() {
  const finder = await readRetry(() => pub.readContract({ address: OO, abi: ooAbi, functionName: 'finder' }), 'finder')
  const iw = await readRetry(() => pub.readContract({ address: finder, abi: finderAbi, functionName: 'getImplementationAddress', args: [b32('IdentifierWhitelist')] }), 'iw')
  const t2 = await readRetry(() => pub.readContract({ address: iw, abi: iwAbi, functionName: 'isIdentifierSupported', args: [b32('ASSERT_TRUTH2')] }), 'AT2')
  const t1 = await readRetry(() => pub.readContract({ address: iw, abi: iwAbi, functionName: 'isIdentifierSupported', args: [b32('ASSERT_TRUTH')] }), 'AT1')
  return { iw, t2, t1 }
}

async function preflight() {
  console.log('=== PRE-FLIGHT (read-only, no transactions) ===')
  console.log('  chainId :', await pub.getChainId(), ' block:', await pub.getBlockNumber())
  if (await pub.getChainId() !== 8453) die('not Base mainnet')
  console.log('\n  -- compile --'); compile()
  console.log('\n  -- UMA identifier (plan prerequisite 2) --')
  const { iw, t2, t1 } = await identifierWhitelisted()
  console.log('    IdentifierWhitelist :', iw)
  console.log('    ASSERT_TRUTH2       :', t2, t2 ? ' OK' : ' *** NOT WHITELISTED ***')
  console.log('    ASSERT_TRUTH        :', t1, ' (expected false)')
  const bond = await readRetry(() => pub.readContract({ address: OO, abi: ooAbi, functionName: 'getMinimumBond', args: [USDC] }), 'bond')
  console.log('    minimum bond        :', f(bond), 'USDC')
  console.log('\n  -- wallet --')
  // Soft check: preflight must stay usable before the key is in place.
  let addr = PROD
  const k = (process.env.MAINNET_PRIVATE_KEY || '').trim()
  const expected = PROD && /^0x[0-9a-fA-F]{40}$/.test(PROD) ? getAddress(PROD) : null
  console.log('    MAINNET_DEPLOY_WALLET:', expected || '*** NOT SET — deploy will abort ***')
  if (!k) {
    console.log('    MAINNET_PRIVATE_KEY : NOT SET — cannot deploy yet')
    if (expected) { addr = expected; console.log('    (continuing read-only against ' + expected + ')') }
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    console.log('    MAINNET_PRIVATE_KEY : BAD FORMAT (expected 0x + 64 hex, length ' + k.length + ')')
  } else {
    const a = privateKeyToAccount(k).address
    addr = a
    const match = expected !== null && getAddress(a) === expected
    console.log('    key derives         :', a, match ? ' MATCHES MAINNET_DEPLOY_WALLET' : ' *** WRONG WALLET ***')
    if (!match) console.log('    expected            :', expected || '(MAINNET_DEPLOY_WALLET not set)')
  }
  const eth = await pub.getBalance({ address: addr })
  const usdc = await readRetry(() => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [addr] }), 'usdc')
  const gp = await pub.getGasPrice()
  const est = gp * 5721552n
  console.log('    ETH                 :', formatEther(eth), ' (est. deploy cost ' + formatEther(est) + ')')
  console.log('    USDC                :', f(usdc))
  console.log('    gas price           :', formatUnits(gp, 9), 'gwei')
  if (!t2) die('ASSERT_TRUTH2 is NOT whitelisted on Base mainnet. Do not deploy.')
  if (eth < est * 3n) console.log('    WARNING: ETH is under 3x the estimated deploy cost')
  if (usdc < 1500000000n) console.log('    NOTE: USDC ' + f(usdc) + ' is below the 1,500 floor in CLAUDE.md (bond cycling)')
  console.log('\n  pre-flight checks passed.' + (k ? '' : ' Key still required before `deploy`.'))
}

async function deploy() {
  console.log('=== DEPLOY — plan steps 1-6 ===')
  if (await pub.getChainId() !== 8453) die('not Base mainnet')
  if (fs.existsSync(STATE)) die('a deploy state file already exists (' + STATE + '). Refusing to deploy twice. Delete it only if you are certain.')
  const w = wallet()
  console.log('  deploying from:', w.account.address)

  console.log('\n  -- step 1: compile --')
  const arts = compile()

  console.log('\n  -- prerequisite: ASSERT_TRUTH2 whitelisted --')
  const { t2 } = await identifierWhitelisted()
  console.log('    ASSERT_TRUTH2:', t2)
  if (!t2) die('ASSERT_TRUTH2 is not whitelisted on Base mainnet')

  const dep = async (n, args = []) => {
    const h = await w.deployContract({ abi: arts[n].abi, bytecode: arts[n].bytecode, args })
    console.log('    ' + n + ' tx: ' + h)
    const r = await pub.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') die(n + ' deployment reverted')
    const code = await untilState(n + ' code visible', () => pub.getCode({ address: r.contractAddress }), c => c && c !== '0x')
    const size = (code.length - 2) / 2
    console.log('    ' + n + ' -> ' + r.contractAddress + '  block ' + r.blockNumber + ', gas ' + r.gasUsed + ', runtime ' + size + ' bytes')
    if (size !== arts[n].size) die(n + ' on-chain size ' + size + ' != compiled ' + arts[n].size)
    return r.contractAddress
  }

  console.log('\n  -- step 2: MarketDeployer --')
  const deployer = await dep('MarketDeployer')
  console.log('\n  -- step 3: SportsbookFactory --')
  const factory = await dep('SportsbookFactory', [USDC, OO, deployer])
  const F = arts.SportsbookFactory.abi

  console.log('\n  -- step 4: verify deployer wiring (THE critical check) --')
  const wired = await untilState('factory.deployer()',
    () => pub.readContract({ address: factory, abi: F, functionName: 'deployer' }), v => !!v)
  console.log('    factory.deployer() =', wired)
  if (getAddress(wired) !== getAddress(deployer))
    die('factory.deployer() is ' + wired + ' but MarketDeployer is ' + deployer +
        '. A factory pointed at the wrong deployer would mint markets running arbitrary code.')
  console.log('    MATCHES MarketDeployer')

  console.log('\n  -- step 5: settlementIdentifier --')
  const sid = await readRetry(() => pub.readContract({ address: factory, abi: F, functionName: 'settlementIdentifier' }), 'sid')
  console.log('    settlementIdentifier =', sid)
  if (sid !== b32('ASSERT_TRUTH2')) die('settlementIdentifier is not ASSERT_TRUTH2. Do NOT call setSettlementIdentifier — that was Sepolia-only.')
  console.log('    == ASSERT_TRUTH2 (setSettlementIdentifier deliberately NOT called)')
  const fUsdc = await readRetry(() => pub.readContract({ address: factory, abi: F, functionName: 'usdc' }), 'f.usdc')
  const fOo   = await readRetry(() => pub.readContract({ address: factory, abi: F, functionName: 'oo' }), 'f.oo')
  const fOwn  = await readRetry(() => pub.readContract({ address: factory, abi: F, functionName: 'owner' }), 'f.owner')
  if (getAddress(fUsdc) !== getAddress(USDC)) die('factory.usdc() mismatch')
  if (getAddress(fOo) !== getAddress(OO)) die('factory.oo() mismatch')
  if (getAddress(fOwn) !== getAddress(w.account.address)) die('factory.owner() is not the production wallet')
  console.log('    usdc/oo/owner all correct')

  console.log('\n  -- step 6: approve USDC (max) to the factory --')
  const ah = await w.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [factory, 2n ** 256n - 1n] })
  console.log('    approve tx: ' + ah)
  await pub.waitForTransactionReceipt({ hash: ah })
  const allow = await untilState('factory allowance visible',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [w.account.address, factory] }), v => v > 0n)
  console.log('    allowance:', allow === 2n ** 256n - 1n ? 'MAX' : f(allow))

  fs.writeFileSync(STATE, JSON.stringify({ chainId: 8453, deployer, factory, owner: w.account.address,
    deployedAt: new Date().toISOString(), seed: LAUNCH_SEED.toString() }, null, 2))
  console.log('\n  state saved ->', STATE)
  console.log('\n=== STEPS 1-6 COMPLETE ===')
  console.log('  MarketDeployer   :', deployer)
  console.log('  SportsbookFactory:', factory)
  console.log('\n  Step 7 (createMarket) is a separate command and needs GAME_ID + ORACLE_Z + --confirm.')
}

async function openMarket() {
  console.log('=== STEP 7 — createMarket ===')
  if (!fs.existsSync(STATE)) die('no deploy state; run `deploy` first')
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const gameId = process.env.GAME_ID
  const oracleZ = process.env.ORACLE_Z
  if (!gameId) die('GAME_ID is not set')
  if (oracleZ === undefined || oracleZ === '') die('ORACLE_Z is not set (4-decimal fixed point, e.g. -35000 for -3.5)')
  if (!process.argv.includes('--confirm'))
    die('refusing without --confirm. This creates a REAL market on mainnet that real users can bet on.')
  const z = BigInt(oracleZ)
  if (z < -5000000n || z > 5000000n) die('ORACLE_Z out of the contract Z_MIN/Z_MAX range')

  const w = wallet()
  const arts = compile()
  const F = arts.SportsbookFactory.abi, M = arts.SportsbookMarket.abi
  const usdc = await readRetry(() => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [w.account.address] }), 'usdc')
  console.log('  gameId :', gameId)
  console.log('  oracleZ:', z.toString(), '(=', (Number(z) / 10000).toFixed(4) + ')')
  console.log('  seed   :', f(LAUNCH_SEED), 'USDC/side  (pulls', f(LAUNCH_SEED * 2n), 'total)')
  console.log('  wallet USDC:', f(usdc))
  if (usdc < LAUNCH_SEED * 2n) die('insufficient USDC for the seed')

  const exists = await readRetry(() => pub.readContract({ address: st.factory, abi: F, functionName: 'marketByGameId', args: [gameId] }), 'existing')
  if (exists && exists !== '0x0000000000000000000000000000000000000000') die('a market already exists for this gameId: ' + exists)

  const h = await w.writeContract({ address: st.factory, abi: F, functionName: 'createMarket', args: [gameId, z, LAUNCH_SEED] })
  console.log('  createMarket tx:', h)
  const rc = await pub.waitForTransactionReceipt({ hash: h })
  if (rc.status !== 'success') die('createMarket reverted')

  const raw = rc.logs.find(l => l.topics[0] === MARKET_CREATED_TOPIC0)
  console.log('\n  -- MarketCreated --')
  console.log('    topic0 present :', !!raw, raw ? '(matches v1.4 topic0 — indexers unaffected)' : '*** TOPIC0 MISMATCH ***')
  if (!raw) die('MarketCreated topic0 does not match ' + MARKET_CREATED_TOPIC0)
  const ev = parseEventLogs({ abi: F, logs: rc.logs }).find(l => l.eventName === 'MarketCreated')
  console.log('    market     :', ev.args.market)
  console.log('    gameId     :', ev.args.gameId)
  console.log('    oracleZ    :', ev.args.oracleZ.toString())
  console.log('    spreadMax  :', ev.args.spreadMax.toString(), ' spreadMin:', ev.args.spreadMin.toString())
  console.log('    feePercent :', ev.args.feePercent.toString(), 'bps')
  console.log('    creator    :', ev.args.creator)
  const market = ev.args.market
  await untilState('market code visible', () => pub.getCode({ address: market }), c => c && c !== '0x')

  const chk = (l, c, d = '') => console.log('    ' + (c ? 'OK  ' : 'FAIL') + '  ' + l + (d ? '  [' + d + ']' : ''))
  console.log('\n  -- market wiring --')
  chk('owner is the production wallet', getAddress(await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'owner' }), 'o')) === getAddress(w.account.address))
  chk('ASSERTION_IDENTIFIER == ASSERT_TRUTH2', (await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'ASSERTION_IDENTIFIER' }), 'id')) === b32('ASSERT_TRUTH2'))
  chk('PROTOCOL_SEED == 1 USDC', (await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'PROTOCOL_SEED' }), 's')) === LAUNCH_SEED)
  chk('bettingOpen', (await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'bettingOpen' }), 'b')) === true)
  chk('FEE_PERCENT == 200 bps', (await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'FEE_PERCENT' }), 'f')) === 200n)

  st.market = market; st.gameId = gameId; st.oracleZ = z.toString(); st.createTx = h
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2))
  console.log('\n=== STEP 7 COMPLETE — market', market, '===')
}

async function verify() {
  console.log('=== POST-DEPLOY VERIFY (read-only) ===')
  if (!fs.existsSync(STATE)) die('no deploy state')
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const arts = compile()
  const F = arts.SportsbookFactory.abi, M = arts.SportsbookMarket.abi
  let pass = 0, fail = 0
  const chk = (l, c, d = '') => { c ? (pass++, console.log('  PASS  ' + l + (d ? '  [' + d + ']' : ''))) : (fail++, console.log('  FAIL  ' + l + '  [' + d + ']')) }
  for (const [n, a] of [['MarketDeployer', st.deployer], ['SportsbookFactory', st.factory]].concat(st.market ? [['SportsbookMarket', st.market]] : [])) {
    const code = await pub.getCode({ address: a }); const size = code ? (code.length - 2) / 2 : 0
    chk(n + ' runtime == compiled', size === arts[n].size, size + ' bytes')
    chk(n + ' under EIP-170', size <= 24576)
  }
  chk('factory.deployer() wired', getAddress(await pub.readContract({ address: st.factory, abi: F, functionName: 'deployer' })) === getAddress(st.deployer))
  chk('factory.settlementIdentifier == ASSERT_TRUTH2', (await pub.readContract({ address: st.factory, abi: F, functionName: 'settlementIdentifier' })) === b32('ASSERT_TRUTH2'))
  chk('factory.owner == production wallet', getAddress(await pub.readContract({ address: st.factory, abi: F, functionName: 'owner' })) === getAddress(PROD))
  if (st.market) {
    chk('marketByGameId resolves', getAddress(await pub.readContract({ address: st.factory, abi: F, functionName: 'marketByGameId', args: [st.gameId] })) === getAddress(st.market))
    chk('market ASSERTION_IDENTIFIER == ASSERT_TRUTH2', (await pub.readContract({ address: st.market, abi: M, functionName: 'ASSERTION_IDENTIFIER' })) === b32('ASSERT_TRUTH2'))
    chk('market bettingOpen', (await pub.readContract({ address: st.market, abi: M, functionName: 'bettingOpen' })) === true)
  }
  console.log('\n=== VERIFY === pass=' + pass + ' fail=' + fail)
  if (fail) process.exit(1)
}

const cmd = process.argv[2]
if (cmd === 'preflight') await preflight()
else if (cmd === 'deploy') await deploy()
else if (cmd === 'open-market') await openMarket()
else if (cmd === 'verify') await verify()
else { console.error('usage: mainnet-deploy.mjs preflight|deploy|open-market|verify'); process.exit(1) }
