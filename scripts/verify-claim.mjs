#!/usr/bin/env node
/**
 * Read-only check of a relayed claim (POST /api/claim -> claimPayoutFor).
 * Signs and sends nothing, and needs no keys.
 *
 *   node verify-claim.mjs <marketAddress> <bettor> <claimTxHash>
 *   (or MARKET=0x... BETTOR=0x... TX=0x... node verify-claim.mjs)
 *
 * Reports the USDC Transfer events in the receipt, the market's BetClaimed /
 * PayoutClaimed events, the bettor's USDC and ETH balances (before and after
 * the tx where the RPC still serves that state), and the relay's balances.
 * Reads go to the public Base RPC, independent of the app's Alchemy endpoint.
 * Exits 1 if any check fails.
 */
import {
  createPublicClient, http, parseAbi, formatUnits, formatEther, getAddress, isAddress, isHash, decodeEventLog,
} from 'viem'
import { base } from 'viem/chains'
import { resolveRelayAddress } from './relay-address.mjs'

const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const RELAY = await resolveRelayAddress() // from data/relay.json, never hard-coded (see relay-address.mjs)

const die = (m) => { console.error('FAIL:', m); process.exit(1) }
const [argMarket, argBettor, argTx] = process.argv.slice(2)
const rawMarket = argMarket ?? process.env.MARKET
const rawBettor = argBettor ?? process.env.BETTOR
const txHash = argTx ?? process.env.TX
if (!rawMarket || !isAddress(rawMarket, { strict: false })) die('market address missing or invalid')
if (!rawBettor || !isAddress(rawBettor, { strict: false })) die('bettor address missing or invalid')
if (!txHash || !isHash(txHash)) die('claim tx hash missing or invalid')
const MARKET = getAddress(rawMarket)
const BETTOR = getAddress(rawBettor)

const pub = createPublicClient({ chain: base, transport: http(process.env.VERIFY_RPC || 'https://mainnet.base.org') })
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const marketAbi = parseAbi([
  'event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout)',
  'event PayoutClaimed(address indexed bettor, uint256 amount)',
])
const usdc = (a, blockNumber) => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [a], blockNumber })
const eth = (address, blockNumber) => pub.getBalance({ address, blockNumber })
// Historical state may be pruned on a public node; report "n/a" rather than fail.
const atBlock = (p) => p.catch(() => null)
const fmtUsdc = (v) => (v === null ? 'n/a' : formatUnits(v, 6))
const fmtEth = (v) => (v === null ? 'n/a' : formatEther(v))

const [tx, receipt] = await Promise.all([pub.getTransaction({ hash: txHash }), pub.getTransactionReceipt({ hash: txHash })])

const checks = []
const check = (name, ok, detail) => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

console.log('tx      :', txHash, `(block ${receipt.blockNumber})`)
console.log('BaseScan:', `https://basescan.org/tx/${txHash}`)
console.log('market  :', MARKET)
console.log('bettor  :', BETTOR)
console.log('\nchecks:')
check('receipt status success', receipt.status === 'success', receipt.status)
check('tx sender is the relay', getAddress(tx.from) === RELAY, tx.from)
check('tx target is the market', tx.to !== null && getAddress(tx.to) === MARKET, tx.to ?? 'contract creation')

const decoded = receipt.logs.map((l) => {
  for (const abi of [marketAbi, erc20]) {
    try { return { address: getAddress(l.address), ...decodeEventLog({ abi, data: l.data, topics: l.topics }) } } catch {}
  }
  return null
}).filter(Boolean)

const transfers = decoded.filter((e) => e.eventName === 'Transfer' && e.address === USDC)
console.log(`\nUSDC Transfer events (${transfers.length}):`)
for (const t of transfers) console.log(`  ${getAddress(t.args.from)} -> ${getAddress(t.args.to)}  ${formatUnits(t.args.value, 6)} USDC`)

const claimed = decoded.filter((e) => e.eventName === 'BetClaimed' && e.address === MARKET)
const payouts = decoded.filter((e) => e.eventName === 'PayoutClaimed' && e.address === MARKET)
console.log(`\nBetClaimed events (${claimed.length}):`)
for (const e of claimed) console.log(`  betId ${e.args.betId}  bettor ${getAddress(e.args.bettor)}  payout ${formatUnits(e.args.payout, 6)} USDC`)
for (const e of payouts) console.log(`PayoutClaimed: bettor ${getAddress(e.args.bettor)}  amount ${formatUnits(e.args.amount, 6)} USDC`)

console.log('')
check('every BetClaimed is for the bettor', claimed.length > 0 && claimed.every((e) => getAddress(e.args.bettor) === BETTOR), String(claimed.length))
check('exactly one PayoutClaimed, to the bettor', payouts.length === 1 && getAddress(payouts[0].args.bettor) === BETTOR)
const amount = payouts[0]?.args.amount ?? -1n
check('PayoutClaimed equals the sum of BetClaimed payouts', claimed.reduce((s, e) => s + e.args.payout, 0n) === amount)
check('USDC market -> bettor transfer equals the payout',
  transfers.some((t) => getAddress(t.args.from) === MARKET && getAddress(t.args.to) === BETTOR && t.args.value === amount),
  fmtUsdc(amount < 0n ? null : amount))
check('no USDC Transfer to or from the relay',
  !transfers.some((t) => getAddress(t.args.from) === RELAY || getAddress(t.args.to) === RELAY))

const before = receipt.blockNumber - 1n
const [bUsdcBefore, bUsdcAfter, bEthBefore, bEthAfter, bUsdcNow, bEthNow, rUsdcNow, rEthNow] = await Promise.all([
  atBlock(usdc(BETTOR, before)), atBlock(usdc(BETTOR, receipt.blockNumber)),
  atBlock(eth(BETTOR, before)), atBlock(eth(BETTOR, receipt.blockNumber)),
  usdc(BETTOR), eth(BETTOR), usdc(RELAY), eth(RELAY),
])

console.log('\nbalances:')
console.log(`  bettor USDC  before tx ${fmtUsdc(bUsdcBefore)}  after tx ${fmtUsdc(bUsdcAfter)}  now ${fmtUsdc(bUsdcNow)}`)
console.log(`  bettor ETH   before tx ${fmtEth(bEthBefore)}  after tx ${fmtEth(bEthAfter)}  now ${fmtEth(bEthNow)}`)
console.log(`  relay  USDC  now ${fmtUsdc(rUsdcNow)}`)
console.log(`  relay  ETH   now ${fmtEth(rEthNow)}`)

if (bUsdcBefore !== null && bUsdcAfter !== null) {
  check('bettor USDC rose by exactly the payout', bUsdcAfter - bUsdcBefore === amount, fmtUsdc(bUsdcAfter - bUsdcBefore))
}
if (bEthBefore !== null && bEthAfter !== null) {
  check('bettor ETH unchanged by the tx (paid no gas)', bEthAfter === bEthBefore)
}
check('relay USDC balance is 0', rUsdcNow === 0n, fmtUsdc(rUsdcNow))

process.exit(checks.every(Boolean) ? 0 : 1)
