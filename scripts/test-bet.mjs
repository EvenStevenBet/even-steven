#!/usr/bin/env node
/**
 * One-off mainnet test of POST /api/bet (relayed, non-custodial placeBetFor).
 *
 *   BETTOR_PRIVATE_KEY=0x... node test-bet.mjs
 *
 * The bettor signs an EIP-3009 ReceiveWithAuthorization for stake + fee; the
 * relay behind the API submits it and pays gas. The bettor needs >= 1.02 USDC
 * and no ETH. Env (shell first, then ~/.even-steven/.env via env-resolve.mjs):
 *   BETTOR_PRIVATE_KEY   required
 *   ETHERSCAN_API_KEY    optional — post-trade checks read the tx from BaseScan when the
 *                        plan covers Base, else from a public Base RPC (independent of the API's)
 *   ALCHEMY_RPC_URL / ALCHEMY_KEY / MAINNET_RPC   reads (public RPC fallback)
 *   API_URL              default http://localhost:3000/api/bet
 *   SIDE                 home (default) or away: which side the 1 USDC bet takes
 *
 *   VERIFY_TX=0x... node test-bet.mjs   re-runs only the post-trade checks against
 *                                       an existing bet tx — signs and POSTs nothing.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createPublicClient, http, parseAbi, encodeAbiParameters, keccak256, toHex,
  formatUnits, formatEther, getAddress, isAddress, decodeEventLog,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'crypto'
import { base } from 'viem/chains'
import { resolveRelayAddress } from './relay-address.mjs'
import { loadEnv } from './env-resolve.mjs'

loadEnv(path.dirname(fileURLToPath(import.meta.url)))

const rawMarket = (process.env.MARKET || '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26').trim()
if (!isAddress(rawMarket, { strict: false })) {
  console.error('FAIL: MARKET is not a valid address'); process.exit(1)
}
const MARKET = getAddress(rawMarket)
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const RELAY = await resolveRelayAddress() // from data/relay.json, never hard-coded (see relay-address.mjs)
const API_URL = process.env.API_URL || 'http://localhost:3000/api/bet'
// SIDE=home (default) bets greaterThan: true, the first team named in gameId. SIDE=away bets the other side.
const SIDE = (process.env.SIDE || 'home').trim().toLowerCase()
if (SIDE !== 'home' && SIDE !== 'away') { console.error('FAIL: SIDE must be "home" or "away"'); process.exit(1) }
const GREATER_THAN = SIDE === 'home'
const STAKE = 1_000_000n

const die = (m) => { console.error('FAIL:', m); process.exit(1) }
const rawKey = (process.env.BETTOR_PRIVATE_KEY || '').trim()
if (!rawKey) die('BETTOR_PRIVATE_KEY not set')
const bettor = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : '0x' + rawKey)
if (bettor.address === RELAY) die('bettor key is the relay key')

const rpc = process.env.MAINNET_RPC || process.env.ALCHEMY_RPC_URL
  || (process.env.ALCHEMY_KEY ? 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_KEY : 'https://mainnet.base.org')
const pub = createPublicClient({ chain: base, transport: http(rpc) })
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const marketAbi = parseAbi([
  'function FEE_PERCENT() view returns (uint256)',
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)',
])
const usdcBal = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [a] })

const VERIFY_TX = process.env.VERIFY_TX
let json

if (VERIFY_TX) {
  json = { txHash: VERIFY_TX }
  console.log('VERIFY_TX mode — checking', VERIFY_TX, 'only; nothing is signed or posted')
} else {
// ── 1. bettor + amounts ────────────────────────────────────────────────────
const feeBps = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: 'FEE_PERCENT' })
const fee = (STAKE * feeBps) / 10_000n
const value = STAKE + fee
const [bettorEth, bettorUsdc] = await Promise.all([pub.getBalance({ address: bettor.address }), usdcBal(bettor.address)])
console.log('bettor      :', bettor.address, `(ETH ${formatEther(bettorEth)}, USDC ${formatUnits(bettorUsdc, 6)})`)
console.log('FEE_PERCENT :', feeBps.toString(), 'bps')
console.log('stake / fee :', STAKE.toString(), '/', fee.toString(), `-> signs value ${value} (${formatUnits(value, 6)} USDC)`)
if (bettorUsdc < value) die(`bettor holds ${formatUnits(bettorUsdc, 6)} USDC, needs ${formatUnits(value, 6)}`)
if (bettorEth > 0n) console.warn('  note: bettor holds ETH; the test still proves the relay paid gas via tx.from')

// ── 2. salt / nonce bound to the side ──────────────────────────────────────
const salt = toHex(randomBytes(32))
const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, GREATER_THAN]))
const validAfter = 0n
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600)

// ── 3. sign ReceiveWithAuthorization ───────────────────────────────────────
const signature = await bettor.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: { from: bettor.address, to: MARKET, value, validAfter, validBefore, nonce },
})

// ── 4. POST — flat body, the shape app/api/bet/route.ts accepts. The route
// splits a 65-byte signature into v/r/s itself and calls placeBetFor.
const body = {
  marketAddress: MARKET,
  bettor: bettor.address,
  greaterThan: GREATER_THAN,
  stake: STAKE.toString(),
  validAfter: validAfter.toString(),
  validBefore: validBefore.toString(),
  nonce,
  salt,
  signature,
}
console.log('\nPOST', API_URL)
const res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const text = await res.text()
try { json = JSON.parse(text) } catch { json = null }
console.log('status:', res.status)
console.log('body  :', json ? JSON.stringify(json, null, 2) : text.slice(0, 500))
if (res.status !== 200 || !json?.success) process.exit(1)

console.log('\nbetId      :', json.betId)
console.log('txHash     :', json.txHash)
console.log('blockNumber:', json.blockNumber)
console.log('BaseScan   :', `https://basescan.org/tx/${json.txHash}`)
}
const fee = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: 'FEE_PERCENT' })
  .then((bps) => (STAKE * bps) / 10_000n)
const value = STAKE + fee

// ── 5. independent checks: BaseScan API if the plan covers Base, else a public
// Base RPC — either way, not the Alchemy endpoint the API server submitted through.
async function fetchTx(hash) {
  if (process.env.ETHERSCAN_API_KEY) {
    const scan = async (action) => {
      const r = await fetch(`https://api.etherscan.io/v2/api?chainid=8453&module=proxy&action=${action}&txhash=${hash}&apikey=${process.env.ETHERSCAN_API_KEY}`)
      const j = await r.json()
      return j.result && typeof j.result === 'object' ? j.result : { error: j.result }
    }
    const tx = await scan('eth_getTransactionByHash')
    if (!tx.error) return { source: 'BaseScan API', tx, receipt: await scan('eth_getTransactionReceipt') }
    console.log('BaseScan API unavailable:', tx.error)
  }
  const indep = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') })
  const [tx, receipt] = await Promise.all([indep.getTransaction({ hash }), indep.getTransactionReceipt({ hash })])
  return { source: 'public RPC mainnet.base.org', tx, receipt: { ...receipt, status: receipt.status === 'success' ? '0x1' : '0x0' } }
}
const { source, tx, receipt } = await fetchTx(json.txHash)
console.log('\nverification source:', source)

const checks = []
const check = (name, ok, detail) => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

console.log('checks:')
check('receipt status success', receipt.status === '0x1', receipt.status)
check('tx sender is the relay', getAddress(tx.from) === RELAY, tx.from)
check('tx target is the market', getAddress(tx.to) === MARKET, tx.to)

const decoded = receipt.logs.map((l) => {
  for (const abi of [marketAbi, erc20]) {
    try { return { address: getAddress(l.address), ...decodeEventLog({ abi, data: l.data, topics: l.topics }) } } catch {}
  }
  return null
}).filter(Boolean)

const bets = decoded.filter((e) => e.eventName === 'BetPlaced' && e.address === MARKET)
check('exactly one BetPlaced from the market', bets.length === 1, String(bets.length))
if (bets[0]) {
  const a = bets[0].args
  check('BetPlaced.bettor is the test bettor', getAddress(a.bettor) === bettor.address, a.bettor)
  console.log(`      betId ${a.betId}, stake ${a.stake}, fee ${a.fee}, greaterThan ${a.greaterThan}, lockedZ ${a.lockedZ}`)
}

const transfers = decoded.filter((e) => e.eventName === 'Transfer' && e.address === USDC)
for (const t of transfers) console.log(`      USDC Transfer ${t.args.from} -> ${t.args.to}  ${formatUnits(t.args.value, 6)}`)
check('no USDC Transfer to or from the relay',
  !transfers.some((t) => getAddress(t.args.from) === RELAY || getAddress(t.args.to) === RELAY))
check('bettor -> market transfer equals stake + fee',
  transfers.some((t) => getAddress(t.args.from) === bettor.address && getAddress(t.args.to) === MARKET && t.args.value === value))

// ── 6. relay balances after ────────────────────────────────────────────────
const [relayEth, relayUsdc] = await Promise.all([pub.getBalance({ address: RELAY }), usdcBal(RELAY)])
console.log(`\nrelay after : ETH ${formatEther(relayEth)}, USDC ${formatUnits(relayUsdc, 6)}`)
check('relay USDC balance is 0', relayUsdc === 0n, formatUnits(relayUsdc, 6))

process.exit(checks.every(Boolean) ? 0 : 1)
