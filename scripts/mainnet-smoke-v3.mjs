#!/usr/bin/env node
/**
 * Plan step 8 — mainnet smoke test of the v3 relayed paths, scoped down.
 *
 * Proves on real Base mainnet, against the deployed v1.11 market:
 *   1. placeBetFor — deploy wallet signs EIP-3009, a SEPARATE freshly-generated
 *      relay submits. BetPlaced.bettor must be the signer, not the relay.
 *   2. cancelMarket — owner call. Refund mode, which returns the seed and makes
 *      stakes refundable without involving UMA. The game has not happened, so a
 *      real oracle assertion is not warranted for a throwaway market.
 *   3. claimPayoutFor — the SAME relay claims for the bettor. Refund-mode
 *      semantics: exactly the stake back, no fee refund.
 *   4. getOpenMarkets() must be empty afterwards, so nothing dangles into the
 *      Vercel cutover.
 *
 * The ERC-1271 and EIP-7702 paths are deliberately NOT repeated here — both are
 * already proven on Base Sepolia and on the pinned mainnet fork.
 *
 *   MAINNET_DEPLOY_WALLET=0x… node mainnet-smoke-v3.mjs --confirm
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, stringToHex,
         encodeAbiParameters, parseEventLogs, formatUnits, formatEther, getAddress, padHex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { base } from 'viem/chains'
import { loadEnv } from './env-resolve.mjs'

const HERE  = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.resolve(HERE, 'mainnet-deploy-v3-state.json')
loadEnv(HERE)

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const STAKE = 1000000n                 // 1 USDC, the contract minimum
const FEE   = STAKE * 200n / 10000n    // 2% taker fee, added on top
const RELAY_FUNDING = 200000000000000n // 0.0002 ETH — ~2 txs at Base gas prices

const die = m => { console.error('\n*** ABORT: ' + m + '\n*** No further transactions will be sent.'); process.exit(1) }
process.on('unhandledRejection', e => die((e?.shortMessage || e?.message || String(e))))

if (!process.argv.includes('--confirm')) die('refusing without --confirm. This sends real mainnet transactions.')
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
const PROD = (process.env.MAINNET_DEPLOY_WALLET || '').trim()
if (!PROD) die('MAINNET_DEPLOY_WALLET is not set')
const key = (process.env.MAINNET_PRIVATE_KEY || '').trim()
if (!key) die('MAINNET_PRIVATE_KEY is not set')
const owner = privateKeyToAccount(key)
if (getAddress(owner.address) !== getAddress(PROD)) die('key derives ' + owner.address + ', expected ' + PROD)

const rpc = process.env.ALCHEMY_RPC_URL
const pub = createPublicClient({ chain: base, transport: http(rpc, { timeout: 120000 }), pollingInterval: 500 })
const wal = a => createWalletClient({ account: a, chain: base, transport: http(rpc, { timeout: 120000 }), pollingInterval: 500 })
const W = wal(owner)

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)', 'function version() view returns (string)',
])
const M = parseAbi([
  'function placeBetFor(address bettor, bool greaterThan, uint256 stake, (uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes32 salt,uint8 v,bytes32 r,bytes32 s) auth)',
  'function cancelMarket()', 'function claimPayoutFor(address bettor, uint256[] betIds)',
  'function refundMode() view returns (bool)', 'function canceled() view returns (bool)',
  'function bettingOpen() view returns (bool)', 'function totalPool() view returns (uint256)',
  'function protocolSeedTotal() view returns (uint256)',
  'function getBet(uint256) view returns ((address bettor,uint256 stake,bool greaterThan,int256 lockedZ,bool claimed))',
  'event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, uint256 fee, bool greaterThan, int256 lockedZ)',
  'event MarketCanceled(address indexed by)',
  'event PayoutClaimed(address indexed bettor, uint256 amount)',
  'event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout)',
])
const F = parseAbi(['function getOpenMarkets() view returns (address[])','function getAllMarkets() view returns (address[])'])
const f = v => formatUnits(v, 6)
const bal = a => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [a] })

/**
 * A pinned-block read can outrun the RPC: it answers "block not found" for a block
 * it has itself just mined. Retry rather than treating that as a failure — this is
 * the same lag that killed the Sepolia phase-1 run mid-sequence.
 */
async function readRetry(fn, label, tries = 20) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000)) }
  }
  die('read failed after ' + tries + ' attempts (' + label + '): ' + ((last?.shortMessage || last?.message || '').split('\n')[0]))
}
const at = (addr, blockNumber) => readRetry(
  () => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [addr], blockNumber }),
  'balanceOf@' + blockNumber)
let pass = 0, fail = 0
const chk = (l, c, d = '') => { c ? (pass++, console.log('    PASS  ' + l + (d ? '  [' + d + ']' : '')))
                                  : (fail++, console.log('    FAIL  ' + l + '  [' + d + ']')) }

console.log('='.repeat(78))
console.log('PLAN STEP 8 — mainnet smoke test (scoped: relayed bet -> cancel -> relayed claim)')
console.log('='.repeat(78))
console.log('  market :', st.market)
console.log('  factory:', st.factory)
console.log('  bettor :', owner.address, '(the deploy wallet, signing EIP-3009)')
if (await pub.getChainId() !== 8453) die('not Base mainnet')
if (!(await pub.readContract({ address: st.market, abi: M, functionName: 'bettingOpen' }))) die('betting is not open on this market')

// ── fresh relay ────────────────────────────────────────────────────────
// Resume rather than restart: this sequence sends real transactions, so a crash
// part-way through must not re-bet or strand a funded relay.
const RELAYFILE = path.resolve(HERE, 'mainnet-smoke-v3-relay.json')
let relayPk, relay
if (fs.existsSync(RELAYFILE)) {
  const saved = JSON.parse(fs.readFileSync(RELAYFILE, 'utf8'))
  if (saved.market !== st.market) die('saved relay belongs to a different market: ' + saved.market)
  relayPk = saved.relayPk; relay = privateKeyToAccount(relayPk)
  console.log('  relay  :', relay.address, '(resumed from ' + path.basename(RELAYFILE) + ')')
} else {
  relayPk = generatePrivateKey(); relay = privateKeyToAccount(relayPk)
  console.log('  relay  :', relay.address, '(freshly generated, funded below)')
  fs.writeFileSync(RELAYFILE, JSON.stringify({ relayAddr: relay.address, relayPk, market: st.market,
                                               createdAt: new Date().toISOString() }, null, 2))
}
const R = wal(relay)

{
  const have = await pub.getBalance({ address: relay.address })
  if (have >= RELAY_FUNDING / 2n) {
    console.log('\n── relay already funded: ' + formatEther(have) + ' ETH ──')
  } else {
    console.log('\n── funding the relay with ' + formatEther(RELAY_FUNDING) + ' ETH ──')
    const h = await W.sendTransaction({ to: relay.address, value: RELAY_FUNDING })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    console.log('    tx:', h, ' block', r.blockNumber.toString(), ' gas', r.gasUsed.toString())
  }
}

// ── 8.1 placeBetFor ────────────────────────────────────────────────────
console.log('\n── 8.1  placeBetFor — bettor signs, RELAY submits ──')
let existingBet = null
try { existingBet = await pub.readContract({ address: st.market, abi: M, functionName: 'getBet', args: [0n] }) } catch {}
if (existingBet && getAddress(existingBet.bettor) === getAddress(owner.address)) {
  console.log('    bet 0 already placed by the bettor — skipping (resumed run)')
  console.log('    stored bet:', JSON.stringify(existingBet, (k, v) => typeof v === 'bigint' ? v.toString() : v))
  chk('BetPlaced.bettor is the DEPLOY WALLET, not the relay',
      getAddress(existingBet.bettor) === getAddress(owner.address), existingBet.bettor)
  chk('stake recorded without the fee', existingBet.stake === STAKE, f(existingBet.stake))
}
if (!existingBet) {
const tokenName = await pub.readContract({ address: USDC, abi: erc20, functionName: 'name' })
const tokenVer  = await pub.readContract({ address: USDC, abi: erc20, functionName: 'version' })
console.log('    USDC name()/version():', JSON.stringify(tokenName), JSON.stringify(tokenVer))
const domain = { name: tokenName, version: tokenVer, chainId: 8453, verifyingContract: USDC }
const types = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }
const greaterThan = true
const salt = keccak256(stringToHex('mainnet-smoke-v3-' + Date.now()))
const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
const validBefore = (await pub.getBlock()).timestamp + 7200n
const sig = await owner.signTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization',
  message: { from: owner.address, to: st.market, value: STAKE + FEE, validAfter: 0n, validBefore, nonce } })
const auth = { validAfter: 0n, validBefore, nonce, salt,
               v: parseInt(sig.slice(130, 132), 16), r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130) }
console.log('    signed: stake', f(STAKE), '+ fee', f(FEE), '= value', f(STAKE + FEE), ' side GREATER')
const betRc = await pub.waitForTransactionReceipt({ hash: await R.writeContract({
  address: st.market, abi: M, functionName: 'placeBetFor', args: [owner.address, greaterThan, STAKE, auth] }) })
if (betRc.status !== 'success') die('placeBetFor reverted')
const bp = parseEventLogs({ abi: M, logs: betRc.logs }).find(l => l.eventName === 'BetPlaced')
console.log('    tx:', betRc.transactionHash, ' block', betRc.blockNumber.toString(), ' gas', betRc.gasUsed.toString())
console.log('    BetPlaced:', JSON.stringify({ bettor: bp.args.bettor, betId: bp.args.betId.toString(),
  stake: f(bp.args.stake), fee: f(bp.args.fee), greaterThan: bp.args.greaterThan, lockedZ: bp.args.lockedZ.toString() }))
chk('tx.from is the RELAY', getAddress(betRc.from) === getAddress(relay.address), betRc.from)
chk('BetPlaced.bettor is the DEPLOY WALLET, not the relay',
    getAddress(bp.args.bettor) === getAddress(owner.address), bp.args.bettor)
chk('stake recorded without the fee', bp.args.stake === STAKE, f(bp.args.stake))
const BB = betRc.blockNumber
chk('relay USDC unchanged across the bet', (await at(relay.address, BB)) - (await at(relay.address, BB - 1n)) === 0n)
}
const betId = 0n

// ── 8.2 cancelMarket ───────────────────────────────────────────────────
console.log('\n── 8.2  cancelMarket — owner call, refund mode ──')
const ownerPreCancel = await bal(owner.address)
const cancelRc = await pub.waitForTransactionReceipt({ hash: await W.writeContract({
  address: st.market, abi: M, functionName: 'cancelMarket' }) })
if (cancelRc.status !== 'success') die('cancelMarket reverted')
const mc = parseEventLogs({ abi: M, logs: cancelRc.logs }).find(l => l.eventName === 'MarketCanceled')
console.log('    tx:', cancelRc.transactionHash, ' block', cancelRc.blockNumber.toString(), ' gas', cancelRc.gasUsed.toString())
console.log('    MarketCanceled:', JSON.stringify({ by: mc.args.by }))
const CB = cancelRc.blockNumber
// Pin these to the cancel block and retry. Read at "latest" they race the RPC's own
// indexing and report the PRE-cancel state, which looks like a contract failure and
// is not one.
const flagAt = fn => readRetry(
  () => pub.readContract({ address: st.market, abi: M, functionName: fn, blockNumber: CB }), fn + '@' + CB)
chk('refundMode == true (at the cancel block)', (await flagAt('refundMode')) === true)
chk('canceled == true (at the cancel block)', (await flagAt('canceled')) === true)
chk('bettingOpen == false (at the cancel block)', (await flagAt('bettingOpen')) === false)
const seedBack = (await at(owner.address, CB)) - (await at(owner.address, CB - 1n))
chk('protocol seed returned to owner at cancel', seedBack === 2000000n, f(seedBack))

// ── 8.3 claimPayoutFor ─────────────────────────────────────────────────
console.log('\n── 8.3  claimPayoutFor — SAME relay claims for the bettor ──')
const claimRc = await pub.waitForTransactionReceipt({ hash: await R.writeContract({
  address: st.market, abi: M, functionName: 'claimPayoutFor', args: [owner.address, [betId]] }) })
if (claimRc.status !== 'success') die('claimPayoutFor reverted')
const ev = parseEventLogs({ abi: M, logs: claimRc.logs })
const pc = ev.find(l => l.eventName === 'PayoutClaimed'), bc = ev.find(l => l.eventName === 'BetClaimed')
const KB = claimRc.blockNumber
console.log('    tx:', claimRc.transactionHash, ' block', KB.toString(), ' gas', claimRc.gasUsed.toString())
console.log('    PayoutClaimed:', JSON.stringify({ bettor: pc.args.bettor, amount: f(pc.args.amount) }))
console.log('    BetClaimed   :', JSON.stringify({ bettor: bc.args.bettor, betId: bc.args.betId.toString(), payout: f(bc.args.payout) }))
chk('claim tx.from is the RELAY', getAddress(claimRc.from) === getAddress(relay.address), claimRc.from)
chk('PayoutClaimed.bettor is the DEPLOY WALLET', getAddress(pc.args.bettor) === getAddress(owner.address))
chk('BetClaimed.bettor/betId match', getAddress(bc.args.bettor) === getAddress(owner.address) && bc.args.betId === betId)
chk('BetClaimed.payout == PayoutClaimed.amount', bc.args.payout === pc.args.amount, f(pc.args.amount))
chk('refund is EXACTLY the stake — no fee refund', pc.args.amount === STAKE, f(pc.args.amount) + ' (fee ' + f(FEE) + ' not returned)')
const bettorDelta = (await at(owner.address, KB)) - (await at(owner.address, KB - 1n))
chk('bettor USDC delta == +stake', bettorDelta === STAKE, f(bettorDelta))
const relayDelta = (await at(relay.address, KB)) - (await at(relay.address, KB - 1n))
chk('relay USDC delta == 0 — never custodies', relayDelta === 0n, f(relayDelta))
chk('bet is marked claimed', (await pub.readContract({ address: st.market, abi: M, functionName: 'getBet', args: [betId] })).claimed === true)
chk('market fully drained', (await bal(st.market)) === 0n, f(await bal(st.market)))

// ── 8.4 nothing dangling ───────────────────────────────────────────────
console.log('\n── 8.4  factory state after wind-down ──')
const open = await pub.readContract({ address: st.factory, abi: F, functionName: 'getOpenMarkets' })
const all  = await pub.readContract({ address: st.factory, abi: F, functionName: 'getAllMarkets' })
console.log('    getOpenMarkets():', open.length, open)
console.log('    getAllMarkets() :', all.length, all)
chk('getOpenMarkets() is EMPTY — nothing dangles into the cutover', open.length === 0, open.length + ' open')

fs.writeFileSync(STATE, JSON.stringify({ ...st, smoke: {
  ...(st.smoke || {}),
  relayAddr: relay.address,
  ...(typeof betRc !== 'undefined' ? { betTx: betRc.transactionHash } : {}),
  cancelTx: cancelRc.transactionHash, claimTx: claimRc.transactionHash,
  betId: betId.toString(), completedAt: new Date().toISOString() } }, null, 2))
console.log('\n' + '='.repeat(78))
console.log('STEP 8 SUMMARY — ' + pass + ' passed, ' + fail + ' failed')
console.log('='.repeat(78))
console.log('  wallet ETH :', formatEther(await pub.getBalance({ address: owner.address })))
console.log('  wallet USDC:', f(await bal(owner.address)))
console.log('  relay  ETH :', formatEther(await pub.getBalance({ address: relay.address })), '(leftover gas)')
if (fail) process.exit(1)
