#!/usr/bin/env node
/**
 * Lifecycle operations for a single live SportsbookMarket v1.10 on Base mainnet.
 *
 *   node market-ops.mjs state                          # read-only
 *   node market-ops.mjs close --confirm                # closeBetting()
 *   node market-ops.mjs request-settlement <spread> --confirm
 *   node market-ops.mjs execute-settlement --confirm   # after the 2h UMA window
 *
 * MARKET defaults to the Bills/Lions market; override with env MARKET=0x...
 * Every write requires --confirm. Nothing runs without it.
 *
 * finalSpread convention (from requestSettlement's own claim text):
 *   positive = HOME team (first named in gameId) won by that margin
 *   negative = AWAY team (second named) won
 *   zero     = tie
 * For NFL-2026-09-17-HOME-Bills-AWAY-Lions that is (Bills score - Lions score).
 */
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, formatEther,
         getAddress, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import dotenv from 'dotenv'

const HERE = path.dirname(fileURLToPath(import.meta.url))
if (fs.existsSync(path.resolve(HERE, '.env'))) dotenv.config({ path: path.resolve(HERE, '.env') })

const MARKET = getAddress(process.env.MARKET || '0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9')
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PROD   = '0x6cF0A0b5282409E24dC35e2c1834f9111315603B'
const RPC    = process.env.MAINNET_RPC || 'https://base-rpc.publicnode.com'
const f = v => formatUnits(v, 6)
const die = m => { console.error('\n*** ABORT: ' + m); process.exit(1) }
process.on('unhandledRejection', e => die((e.shortMessage || e.message || '') + (e.details ? ' | ' + e.details : '')))

const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 120000 }) })
const M = parseAbi([
  'function bettingOpen() view returns (bool)', 'function settled() view returns (bool)',
  'function canceled() view returns (bool)', 'function assertionActive() view returns (bool)',
  'function gameId() view returns (string)', 'function currentZ() view returns (int256)',
  'function greaterPool() view returns (uint256)', 'function lessEqualPool() view returns (uint256)',
  'function totalPool() view returns (uint256)', 'function protocolSeedTotal() view returns (uint256)',
  'function finalSpread() view returns (int256)', 'function settledAt() view returns (uint256)',
  'function bettingClosedAt() view returns (uint256)', 'function owner() view returns (address)',
  'function getSettlementBond() view returns (uint256)', 'function cachedWinningStakes() view returns (uint256)',
  'function closeBetting()', 'function requestSettlement(int256)', 'function executeSettlement()',
  'event BettingClosed(uint256 timestamp)',
  'event SettlementRequested(bytes32 assertionId, int256 proposedSpread, address asserter)',
  'event MarketSettled(int256 indexed finalSpread, bool refundMode, bool viaOracle)',
])
const E = parseAbi(['function balanceOf(address) view returns (uint256)',
                    'function approve(address,uint256) returns (bool)',
                    'function allowance(address,address) view returns (uint256)'])

function wallet() {
  const k = (process.env.MAINNET_PRIVATE_KEY || '').trim()
  if (!k) die('MAINNET_PRIVATE_KEY not set')
  const a = privateKeyToAccount(k)
  if (getAddress(a.address) !== getAddress(PROD)) die('key is not the production wallet')
  return createWalletClient({ account: a, chain: base, transport: http(RPC, { timeout: 120000 }) })
}
const r = (fn, args) => pub.readContract({ address: MARKET, abi: M, functionName: fn, args })
async function untilState(label, read, want, tries = 40) {
  for (let i = 0; i < tries; i++) { try { const v = await read(); if (want(v)) return v } catch (e) {} 
    await new Promise(s => setTimeout(s, 2000)) }
  die('state not visible after ' + tries * 2 + 's: ' + label)
}

async function state() {
  console.log('market :', MARKET)
  console.log('gameId :', await r('gameId'))
  const [open, set, can, act] = [await r('bettingOpen'), await r('settled'), await r('canceled'), await r('assertionActive')]
  console.log('bettingOpen:', open, ' settled:', set, ' canceled:', can, ' assertionActive:', act)
  console.log('pools  : greater=' + f(await r('greaterPool')) + ' lessEqual=' + f(await r('lessEqualPool')) +
              ' total=' + f(await r('totalPool')) + ' seed=' + f(await r('protocolSeedTotal')))
  console.log('currentZ:', (await r('currentZ')).toString())
  const cb = await r('bettingClosedAt'), sa = await r('settledAt')
  if (cb > 0n) console.log('bettingClosedAt:', new Date(Number(cb) * 1000).toISOString())
  if (sa > 0n) console.log('settledAt      :', new Date(Number(sa) * 1000).toISOString(),
                           ' finalSpread:', (await r('finalSpread')).toString(),
                           ' winningStakes:', f(await r('cachedWinningStakes')))
  console.log('UMA bond required:', f(await r('getSettlementBond')), 'USDC (market floors at 100)')
  console.log('prod wallet USDC :', f(await pub.readContract({ address: USDC, abi: E, functionName: 'balanceOf', args: [PROD] })))
  console.log('prod wallet ETH  :', formatEther(await pub.getBalance({ address: PROD })))
}

async function close() {
  if (!process.argv.includes('--confirm')) die('refusing without --confirm')
  if (!(await r('bettingOpen'))) die('betting is already closed')
  const w = wallet()
  const h = await w.writeContract({ address: MARKET, abi: M, functionName: 'closeBetting' })
  console.log('closeBetting tx:', h)
  const rc = await pub.waitForTransactionReceipt({ hash: h })
  if (rc.status !== 'success') die('closeBetting reverted')
  const ev = parseEventLogs({ abi: M, logs: rc.logs }).find(l => l.eventName === 'BettingClosed')
  console.log('  block', rc.blockNumber, 'gas', rc.gasUsed)
  console.log('  BettingClosed(timestamp=' + ev.args.timestamp + ') =',
              new Date(Number(ev.args.timestamp) * 1000).toISOString())
  await untilState('bettingOpen false', () => r('bettingOpen'), v => v === false)
  console.log('  confirmed: bettingOpen == false')
}

async function requestSettlement() {
  const raw = process.argv[3]
  if (raw === undefined || raw.startsWith('--')) die('usage: request-settlement <finalSpread> --confirm')
  const spread = BigInt(raw)
  if (spread < -100n || spread > 100n) die('finalSpread outside the market SPREAD_MIN/MAX (-100..100)')
  if (!process.argv.includes('--confirm')) die('refusing without --confirm')
  if (await r('bettingOpen')) die('betting is still open — close it first')
  if (await r('settled')) die('already settled')
  if (await r('assertionActive')) die('an assertion is already pending')

  const w = wallet()
  const bond = await r('getSettlementBond')
  const need = bond > 100000000n ? bond : 100000000n
  const bal = await pub.readContract({ address: USDC, abi: E, functionName: 'balanceOf', args: [PROD] })
  console.log('finalSpread:', spread.toString(), '(positive = Bills won by that margin)')
  console.log('bond       :', f(need), 'USDC   wallet:', f(bal))
  if (bal < need) die('insufficient USDC for the bond')

  const allow = await pub.readContract({ address: USDC, abi: E, functionName: 'allowance', args: [PROD, MARKET] })
  if (allow < need) {
    console.log('  approving USDC to the market...')
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({
      address: USDC, abi: E, functionName: 'approve', args: [MARKET, 2n ** 256n - 1n] }) })
    await untilState('allowance visible',
      () => pub.readContract({ address: USDC, abi: E, functionName: 'allowance', args: [PROD, MARKET] }), v => v >= need)
  }
  const h = await w.writeContract({ address: MARKET, abi: M, functionName: 'requestSettlement', args: [spread] })
  console.log('requestSettlement tx:', h)
  const rc = await pub.waitForTransactionReceipt({ hash: h })
  if (rc.status !== 'success') die('requestSettlement reverted')
  const ev = parseEventLogs({ abi: M, logs: rc.logs }).find(l => l.eventName === 'SettlementRequested')
  console.log('  assertionId :', ev.args.assertionId)
  console.log('  spread      :', ev.args.proposedSpread.toString(), ' asserter:', ev.args.asserter)
  console.log('  block', rc.blockNumber)
  const ready = new Date(Date.now() + 7200 * 1000)
  console.log('\n  UMA liveness is 7200s. Earliest executeSettlement:', ready.toISOString())
  console.log('  (add a few minutes of margin — the window runs from the assertion block timestamp)')
}

async function executeSettlement() {
  if (!process.argv.includes('--confirm')) die('refusing without --confirm')
  if (await r('settled')) die('already settled')
  if (!(await r('assertionActive'))) die('no active assertion — run request-settlement first')
  const w = wallet()
  const h = await w.writeContract({ address: MARKET, abi: M, functionName: 'executeSettlement' })
  console.log('executeSettlement tx:', h)
  const rc = await pub.waitForTransactionReceipt({ hash: h })
  if (rc.status !== 'success') die('executeSettlement reverted')
  const ev = parseEventLogs({ abi: M, logs: rc.logs }).find(l => l.eventName === 'MarketSettled')
  if (ev) {
    console.log('  MarketSettled: finalSpread=' + ev.args.finalSpread +
                ' refundMode=' + ev.args.refundMode + ' viaOracle=' + ev.args.viaOracle)
  } else {
    console.log('  no MarketSettled event — the assertion resolved FALSE (disputed).')
    console.log('  assertionActive is cleared; re-run request-settlement with the correct spread.')
  }
  await untilState('settled visible', () => r('settled'), v => v === true).catch(() => {})
  console.log('  settled:', await r('settled'))
  const tP = await r('totalPool'), sT = await r('protocolSeedTotal')
  const bal = await pub.readContract({ address: USDC, abi: E, functionName: 'balanceOf', args: [MARKET] })
  console.log('  market holds', f(bal), 'vs distributable', f(tP - sT), bal === tP - sT ? '(seed returned OK)' : '')
}

const cmd = process.argv[2]
if (cmd === 'state') await state()
else if (cmd === 'close') await close()
else if (cmd === 'request-settlement') await requestSettlement()
else if (cmd === 'execute-settlement') await executeSettlement()
else { console.error('usage: market-ops.mjs state|close|request-settlement <spread>|execute-settlement'); process.exit(1) }
