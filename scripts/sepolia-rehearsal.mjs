#!/usr/bin/env node
/**
 * Base Sepolia live rehearsal for SportsbookMarket v1.10 / SportsbookFactory v1.5.
 *
 * Proves the full non-custodial agent path on a real network:
 *   agent signs EIP-3009  ->  separate relay submits placeBetFor  ->  agent owns the bet
 *   ->  UMA settlement  ->  agent claims its own payout directly.
 *
 * Two phases, because UMA liveness is 7200s of real time and cannot be fast-forwarded:
 *   node sepolia-rehearsal.mjs phase1     # deploy -> bets -> requestSettlement
 *   ...wait ~2 hours...
 *   node sepolia-rehearsal.mjs phase2     # executeSettlement -> claim
 * State is written to sepolia-rehearsal-state.json between phases.
 *
 * REQUIREMENTS
 *   env SEPOLIA_PRIVATE_KEY  funded with Base Sepolia ETH and >= ~103 testnet USDC.
 *                            100 of that is the UMA bond and comes back after settlement.
 *   env RELAY_PRIVATE_KEY    optional; a SEPARATE funded key used to submit placeBetFor.
 *                            Defaults to a generated key auto-funded with ETH from the
 *                            main key. It must NOT be the agent, or the test proves nothing.
 *   env STAKE_USDC           optional, default 1 (the contract minimum).
 *   env SEED_USDC            optional, default 1 — the per-side protocol seed, matching
 *                            the launch decision. Set to 0 to rehearse the seedless path
 *                            (do that before flipping the bot to seedless, not before this
 *                            deploy). Both paths are already proven on a mainnet fork.
 *
 * Run with viem available, e.g. from repo/market-opener-bot:
 *   SEPOLIA_PRIVATE_KEY=0x... node ../scripts/sepolia-rehearsal.mjs phase1
 *
 * TWO TESTNET-SPECIFIC FACTS THIS SCRIPT HANDLES FOR YOU — both verified on-chain,
 * both of which would otherwise make a correct build look broken:
 *   1. Base Sepolia USDC reports name() == "USDC". Base mainnet reports "USD Coin".
 *      The EIP-712 domain differs, so a signature built with the mainnet name is invalid.
 *   2. ASSERT_TRUTH2 is NOT whitelisted on Base Sepolia (ASSERT_TRUTH is) — the exact
 *      inverse of mainnet. The factory ships defaulting to ASSERT_TRUTH2, so this script
 *      calls setSettlementIdentifier("ASSERT_TRUTH") before creating the market.
 *      DO NOT carry that call over to mainnet.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import solc from 'solc'
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, stringToHex,
         encodeAbiParameters, parseEventLogs, formatUnits, getAddress, padHex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import dotenv from 'dotenv'

const HERE      = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS = path.resolve(HERE, '../contracts')
const STATE     = path.resolve(HERE, 'sepolia-rehearsal-state.json')
const ENVFILE   = path.resolve(HERE, '.env')

// Load .env from THIS directory, not the cwd, so the script works from anywhere.
// Real env vars already set take precedence (dotenv does not override by default).
if (fs.existsSync(ENVFILE)) dotenv.config({ path: ENVFILE })

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const OO   = '0x0F7fC5E6482f096380db6158f978167b57388deE'
const RPC  = process.env.SEPOLIA_RPC || 'https://sepolia.base.org'
const STAKE = BigInt(Math.round(Number(process.env.STAKE_USDC || '1') * 1e6))
const SEED  = BigInt(Math.round(Number(process.env.SEED_USDC  || '1') * 1e6))
const f = v => formatUnits(v, 6)
const b32 = s => padHex(stringToHex(s), { size: 32, dir: 'right' })

const onErr = e => {
  console.error('\n!! ERROR: ' + ((e.shortMessage || e.message || '').split('\n')[0]))
  if (e.details) console.error('   details: ' + e.details)
  if (e.metaMessages) console.error('   ' + e.metaMessages.slice(0, 3).join(' | '))
  console.error('   (state, if any, is in ' + STATE + ')')
  process.exit(1)
}
process.on('unhandledRejection', onErr)
process.on('uncaughtException', onErr)

/**
 * Public Sepolia RPCs load-balance across nodes, so an eth_call issued straight
 * after a deploy can hit a node that has not yet seen the new contract and come
 * back as "returned no data". Poll until the code is actually visible before
 * reading from it. This changes no assertion — it only stops a propagation race
 * from being misreported as a contract failure. A forked node never shows this,
 * because it has no propagation delay.
 */
async function waitForCode(addr, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const code = await pub.getCode({ address: addr }).catch(() => undefined)
    if (code && code !== '0x') return (code.length - 2) / 2
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('no code at ' + addr + ' (' + label + ') after ' + (tries * 2) + 's')
}

/**
 * Poll until a write's effect is actually visible.
 *
 * sepolia.base.org load-balances across nodes, so a read issued straight after a
 * confirmed write routinely lands on a node that has not caught up yet. This bites
 * writes too: viem simulates via eth_call before sending, so a transaction whose
 * precondition was set moments earlier can be rejected by a lagging node. Observed
 * live: setSettlementIdentifier and approve() both confirmed on-chain, yet the very
 * next read/simulate saw the pre-write state.
 *
 * This asserts nothing on its own — it only waits for the network to agree with what
 * the chain already recorded, so the real assertions below test the contract instead
 * of RPC timing. A forked node never shows this; it has no propagation delay.
 */
async function untilState(label, read, want, tries = 40) {
  let last, lastErr
  for (let i = 0; i < tries; i++) {
    try { last = await read(); lastErr = undefined; if (want(last)) return last }
    catch (e) { lastErr = (e.shortMessage || e.message || '').split('\n')[0] }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('state never became visible after ' + (tries * 2) + 's: ' + label +
                  (lastErr ? ' (read kept throwing: ' + lastErr + ')'
                           : ' (last seen: ' + String(last) + ')'))
}

/** Retry a read through a transient RPC hiccup. Never retries a write. */
async function readRetry(fn, label, tries = 5) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000)) }
  }
  throw new Error('read failed after ' + tries + ' attempts (' + label + '): ' +
                  ((last?.shortMessage || last?.message || '').split('\n')[0]))
}

let pass = 0, fail = 0
const chk = (l, c, d = '') => { c ? (pass++, console.log('  PASS  ' + l + (d ? '  [' + d + ']' : '')))
                                  : (fail++, console.log('  FAIL  ' + l + '  [' + d + ']')) }

if (!process.env.SEPOLIA_PRIVATE_KEY) {
  console.error('SEPOLIA_PRIVATE_KEY is required.')
  console.error(fs.existsSync(ENVFILE)
    ? '  ' + ENVFILE + ' exists but does not define SEPOLIA_PRIVATE_KEY.'
    : '  No .env found at ' + ENVFILE + ' — create it, or export the variable.')
  process.exit(1)
}
{
  // Fail fast on a malformed key rather than deep inside a transaction.
  const k = process.env.SEPOLIA_PRIVATE_KEY.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    console.error('SEPOLIA_PRIVATE_KEY must be 0x followed by 64 hex characters (got length ' + k.length + ').')
    process.exit(1)
  }
  process.env.SEPOLIA_PRIVATE_KEY = k
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC, { timeout: 120000 }) })
const wal = pk => createWalletClient({ account: privateKeyToAccount(pk), chain: baseSepolia,
                                       transport: http(RPC, { timeout: 120000 }) })
const owner = wal(process.env.SEPOLIA_PRIVATE_KEY)

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function name() view returns (string)',
])

function compile() {
  const files = ['SportsbookMarket-v1_10.sol', 'MarketDeployer-v1_0.sol', 'SportsbookFactory-v1_5.sol']
  const sources = {}
  for (const f of files) sources[f] = { content: fs.readFileSync(path.join(CONTRACTS, f), 'utf8') }
  const ozRoots = [ path.resolve(HERE, 'node_modules/@openzeppelin/contracts'),
                    path.resolve(HERE, '../node_modules/@openzeppelin/contracts'),
                    path.resolve(process.cwd(), 'node_modules/@openzeppelin/contracts') ]
  const findImport = imp => {
    const m = imp.match(/^@openzeppelin\/contracts@?[\d.]*\/(.*)$/)
    const candidates = m ? ozRoots.map(r => path.join(r, m[1]))
                         : [ path.join(CONTRACTS, imp.replace(/^\.\//, '')) ]
    for (const p of candidates) {
      try { return { contents: fs.readFileSync(p, 'utf8') } } catch (e) {}
    }
    return { error: 'not found: ' + imp + ' (looked in: ' + candidates.join(', ') + ')' }
  }
  const input = { language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 1 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } } } }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))
  const errs = (out.errors || []).filter(e => e.severity === 'error')
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); process.exit(1) }
  const arts = {}
  for (const fl of Object.keys(out.contracts))
    for (const [n, c] of Object.entries(out.contracts[fl]))
      if (c.evm.bytecode.object) arts[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
                                             size: c.evm.deployedBytecode.object.length / 2 }
  if (!solc.version().startsWith('0.8.20+commit.a1b79de6'))
    console.warn('  WARNING: solc is ' + solc.version() + ', expected 0.8.20+commit.a1b79de6')
  return arts
}

async function phase1() {
  console.log('=== PHASE 1 — deploy, bet, request settlement ===')
  console.log('owner/asserter:', owner.account.address)
  const arts = compile()
  for (const n of ['MarketDeployer', 'SportsbookFactory', 'SportsbookMarket'])
    console.log('  ' + n.padEnd(20), arts[n].size, 'bytes', arts[n].size > 24576 ? '  *** OVER EIP-170 ***' : '')
  chk('all contracts under EIP-170',
      ['MarketDeployer','SportsbookFactory','SportsbookMarket'].every(n => arts[n].size <= 24576))

  const bal = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [owner.account.address] })
  console.log('owner USDC balance:', f(bal))
  // 100 USDC UMA bond (returned) + both stakes + both fees + the two-sided seed
  const needed = 100000000n + STAKE * 2n + (STAKE * 2n * 200n) / 10000n + SEED * 2n
  if (bal < needed) { console.error('Insufficient testnet USDC. Need ~' + f(needed) + ', have ' + f(bal) +
    '\n(100 USDC of that is the UMA bond and is returned after settlement.)'); process.exit(1) }

  const dep = async (n, args = []) => {
    const h = await owner.deployContract({ abi: arts[n].abi, bytecode: arts[n].bytecode, args })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    const onchain = await waitForCode(r.contractAddress, n)
    console.log('  deployed ' + n + ' -> ' + r.contractAddress + '  (tx ' + h + ')')
    console.log('    block ' + r.blockNumber + ', gas ' + r.gasUsed + ', on-chain runtime ' + onchain + ' bytes')
    if (onchain !== arts[n].size) console.log('    NOTE on-chain size differs from compiled ' + arts[n].size)
    return r.contractAddress
  }
  const deployer = await dep('MarketDeployer')
  const factory  = await dep('SportsbookFactory', [USDC, OO, deployer])
  const F = arts.SportsbookFactory.abi, M = arts.SportsbookMarket.abi

  const wiredDeployer = await readRetry(
    () => pub.readContract({ address: factory, abi: F, functionName: 'deployer' }), 'factory.deployer()')
  chk('factory.deployer() matches deployed MarketDeployer',
      getAddress(wiredDeployer) === getAddress(deployer), wiredDeployer)

  // TESTNET ONLY — ASSERT_TRUTH2 is not whitelisted on Base Sepolia.
  console.log('\nsetting settlementIdentifier to ASSERT_TRUTH (Sepolia only)...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: factory, abi: F, functionName: 'setSettlementIdentifier', args: [b32('ASSERT_TRUTH')] }) })
  const sid = await untilState('settlementIdentifier visible',
    () => pub.readContract({ address: factory, abi: F, functionName: 'settlementIdentifier' }),
    v => v === b32('ASSERT_TRUTH'))
  chk('settlementIdentifier == ASSERT_TRUTH', sid === b32('ASSERT_TRUTH'), sid)

  // The factory pulls seed * 2 from the creator during createMarket, so it needs an
  // allowance first. Circle USDC on Base rejects exact-amount approvals intermittently —
  // always approve max. Skipped entirely when rehearsing the seedless path.
  if (SEED > 0n) {
    console.log('\napproving factory for USDC (seed pull)...')
    await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
      address: USDC, abi: erc20, functionName: 'approve', args: [factory, 2n ** 256n - 1n] }) })
    await untilState('factory allowance visible',
      () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [owner.account.address, factory] }),
      v => v > 0n)
  }

  const gameId = 'NFL-2026-09-14-HOME-Rehearsal-AWAY-Sepolia-' + Date.now()
  console.log('\ncreating market (seed ' + f(SEED) + ' USDC/side):', gameId)
  const rc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: factory, abi: F, functionName: 'createMarket', args: [gameId, -35000n, SEED] }) })
  const market = parseEventLogs({ abi: F, logs: rc.logs }).find(l => l.eventName === 'MarketCreated').args.market
  console.log('  market ->', market, ' (tx ' + rc.transactionHash + ')')
  await waitForCode(market, 'SportsbookMarket')
  chk('PROTOCOL_SEED matches requested seed',
      await pub.readContract({ address: market, abi: M, functionName: 'PROTOCOL_SEED' }) === SEED, f(SEED))
  chk('protocolSeedTotal == 2x per-side seed',
      await pub.readContract({ address: market, abi: M, functionName: 'protocolSeedTotal' }) === SEED * 2n)

  // agent + relay
  const agentPk = generatePrivateKey(), agent = privateKeyToAccount(agentPk)
  const relayPk = process.env.RELAY_PRIVATE_KEY || generatePrivateKey()
  const relay = wal(relayPk)
  console.log('\nagent (signer) :', agent.address)
  console.log('relay (submits):', relay.account.address)
  chk('relay is NOT the agent', getAddress(relay.account.address) !== getAddress(agent.address))

  // fund agent with USDC (for the stake) and relay with ETH (for gas)
  const cost = STAKE + (STAKE * 200n) / 10000n
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: USDC, abi: erc20, functionName: 'transfer', args: [agent.address, cost] }) })
  await untilState('agent USDC funding visible',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [agent.address] }),
    v => v >= cost)
  if (!process.env.RELAY_PRIVATE_KEY) {
    await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({
      to: relay.account.address, value: 2000000000000000n }) })
    await untilState('relay gas funding visible',
      () => pub.getBalance({ address: relay.account.address }), v => v > 0n)
  }
  // The agent needs native gas of its own. EIP-3009 makes PLACING a bet gasless for
  // the agent — the relay pays — but CLAIMING is a direct call from the agent, so it
  // must hold ETH. A forked node hides this (balances are just set); on a real
  // network an agent funded only in USDC cannot collect its own winnings.
  await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({
    to: agent.address, value: 2000000000000000n }) })
  await untilState('agent gas funding visible',
    () => pub.getBalance({ address: agent.address }), v => v > 0n)

  // agent signs ReceiveWithAuthorization — note Sepolia name() is "USDC"
  const tokenName = await pub.readContract({ address: USDC, abi: erc20, functionName: 'name' })
  console.log('\nUSDC name() on this network:', JSON.stringify(tokenName))
  const domain = { name: tokenName, version: '2', chainId: 84532, verifyingContract: USDC }
  const types = { ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }
  const salt = keccak256(stringToHex('rehearsal-' + Date.now()))
  const greaterThan = true
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
  const blk = await pub.getBlock()
  const validBefore = blk.timestamp + 7200n
  const sig = await agent.signTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization',
    message: { from: agent.address, to: market, value: cost, validAfter: 0n, validBefore, nonce } })
  const auth = { validAfter: 0n, validBefore, nonce, salt,
                 v: parseInt(sig.slice(130, 132), 16), r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130) }

  console.log('\nrelay submitting placeBetFor...')
  const betRc = await pub.waitForTransactionReceipt({ hash: await relay.writeContract({
    address: market, abi: M, functionName: 'placeBetFor', args: [agent.address, greaterThan, STAKE, auth] }) })
  const bp = parseEventLogs({ abi: M, logs: betRc.logs }).find(l => l.eventName === 'BetPlaced')
  console.log('  tx:', betRc.transactionHash, ' gas:', betRc.gasUsed, ' block:', betRc.blockNumber)
  console.log('  BetPlaced decoded:', JSON.stringify({ bettor: bp.args.bettor, betId: bp.args.betId.toString(),
    stake: f(bp.args.stake), fee: f(bp.args.fee), greaterThan: bp.args.greaterThan, lockedZ: bp.args.lockedZ.toString() }))

  // Take the before/after snapshot at FIXED block heights either side of the bet
  // rather than at "latest". On a load-balanced RPC "latest" is whatever the node
  // answering happens to have, which makes a balance delta meaningless. Pinning
  // both sides to explicit blocks makes the measurement exact and reproducible —
  // anyone can re-read these two blocks and get the same numbers.
  const B = betRc.blockNumber, A = betRc.blockNumber - 1n
  await untilState('node caught up to bet block ' + B,
    () => pub.getBlockNumber(), n => n >= B)
  const readAt = (address, abi, functionName, args, blockNumber) =>
    readRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }),
              functionName + '@' + blockNumber)

  chk('BetPlaced.bettor == AGENT (signer), not relay', getAddress(bp.args.bettor) === getAddress(agent.address), bp.args.bettor)

  const bet0 = await readAt(market, M, 'getBet', [bp.args.betId], B)
  chk('stored bet.bettor == AGENT (msg.sender was the relay)',
      getAddress(bet0.bettor) === getAddress(agent.address), bet0.bettor)
  chk('stored bet.stake is stake only, fee excluded', bet0.stake === STAKE, f(bet0.stake))
  chk('stored bet.greaterThan matches the signed side', bet0.greaterThan === greaterThan)

  const agentIds = await readAt(market, M, 'getBetsByAddress', [agent.address], B)
  const relayIds = await readAt(market, M, 'getBetsByAddress', [relay.account.address], B)
  chk('getBetsByAddress(agent) holds the bet', agentIds.length === 1, 'ids=[' + agentIds.join(',') + ']')
  chk('getBetsByAddress(relay) is empty', relayIds.length === 0, 'ids=[' + relayIds.join(',') + ']')

  const relayBefore = await readAt(USDC, erc20, 'balanceOf', [relay.account.address], A)
  const relayAfter  = await readAt(USDC, erc20, 'balanceOf', [relay.account.address], B)
  chk('relay USDC unchanged across placeBetFor (never custodies)',
      relayAfter === relayBefore, 'before ' + f(relayBefore) + ' after ' + f(relayAfter))

  const agentBefore = await readAt(USDC, erc20, 'balanceOf', [agent.address], A)
  const agentAfter  = await readAt(USDC, erc20, 'balanceOf', [agent.address], B)
  chk('agent paid exactly stake + fee', agentBefore - agentAfter === cost, f(agentBefore - agentAfter))

  const ownerBefore = await readAt(USDC, erc20, 'balanceOf', [owner.account.address], A)
  const ownerAfter  = await readAt(USDC, erc20, 'balanceOf', [owner.account.address], B)
  chk('owner received exactly the 2% fee',
      ownerAfter - ownerBefore === (STAKE * 200n) / 10000n, f(ownerAfter - ownerBefore))

  const gPoolA = await readAt(market, M, 'greaterPool', [], A)
  const gPoolB = await readAt(market, M, 'greaterPool', [], B)
  const tPoolA = await readAt(market, M, 'totalPool', [], A)
  const tPoolB = await readAt(market, M, 'totalPool', [], B)
  chk('greaterPool rose by stake only (fee never enters the pool)', gPoolB - gPoolA === STAKE, f(gPoolB - gPoolA))
  chk('totalPool rose by stake only', tPoolB - tPoolA === STAKE, f(tPoolB - tPoolA))

  const zAfterBet = await readAt(market, M, 'currentZ', [], B)
  chk('R6-6: Z moved on one-sided flow', zAfterBet !== -35000n, zAfterBet.toString())

  // opposing bet from owner so there is a loser
  console.log('\nplacing opposing bet (owner, normal placeBet)...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: USDC, abi: erc20, functionName: 'approve', args: [market, 2n ** 256n - 1n] }) })
  await untilState('market allowance visible (opposing bet)',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [owner.account.address, market] }),
    v => v > 0n)
  const oppRc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: market, abi: M, functionName: 'placeBet', args: [false, STAKE] }) })
  const OB = oppRc.blockNumber
  await untilState('node caught up to opposing-bet block ' + OB, () => pub.getBlockNumber(), n => n >= OB)
  console.log('  opposing bet tx:', oppRc.transactionHash, ' block:', OB)

  // Quote pinned to the block the pools actually reached, so the number recorded
  // here is the one phase2 compares the realised payout against.
  const [curQ, liqQ, vig] = await readRetry(
    () => pub.readContract({ address: market, abi: M, functionName: 'getMarketEV', args: [STAKE, true], blockNumber: OB }),
    'getMarketEV@' + OB)
  const gP = await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'greaterPool', blockNumber: OB }), 'gPool')
  const lP = await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'lessEqualPool', blockNumber: OB }), 'lPool')
  const tP = await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'totalPool', blockNumber: OB }), 'tPool')
  const sT = await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'protocolSeedTotal', blockNumber: OB }), 'seedTotal')
  console.log('  pools @' + OB + ': greater=' + f(gP) + ' lessEqual=' + f(lP) + ' total=' + f(tP) + ' seed=' + f(sT))
  console.log('  getMarketEV: currentPayout=' + f(curQ) + ' liquidPayout=' + f(liqQ) + ' impliedVig=' + vig + 'bps')

  // What the unpatched v1.9 formula would have quoted from this same state (R6-4).
  const oldQuote = (STAKE * ((tP + STAKE) - sT)) / (gP + STAKE)
  console.log('  v1.9 would have quoted: ' + f(oldQuote) + '  <-- the R6-4 bug')
  chk('liquidPayout == exactly 2x stake', liqQ === STAKE * 2n, f(liqQ))
  chk('impliedVig == FEE_PERCENT (200 bps)', vig === 200n, vig + 'bps')

  console.log('\nclosing betting and requesting settlement (finalSpread = 0)...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: market, abi: M, functionName: 'closeBetting' }) })
  // requestSettlement reverts while bettingOpen is still true, so wait for the
  // close to be visible rather than letting a lagging node reject the simulation.
  await untilState('closeBetting visible',
    () => pub.readContract({ address: market, abi: M, functionName: 'bettingOpen' }), v => v === false)
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: USDC, abi: erc20, functionName: 'approve', args: [market, 2n ** 256n - 1n] }) })
  await untilState('market allowance visible (settlement bond)',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [owner.account.address, market] }),
    v => v >= 100000000n)
  const reqRc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: market, abi: M, functionName: 'requestSettlement', args: [0n] }) })
  const sr = parseEventLogs({ abi: M, logs: reqRc.logs }).find(l => l.eventName === 'SettlementRequested')
  console.log('  assertionId:', sr.args.assertionId)
  console.log('  tx:', reqRc.transactionHash, ' block:', reqRc.blockNumber)
  console.log('  proposedSpread:', sr.args.proposedSpread, ' asserter:', sr.args.asserter)
  chk('SettlementRequested.asserter == owner', getAddress(sr.args.asserter) === getAddress(owner.account.address))
  chk('assertionId is non-zero', sr.args.assertionId !== '0x' + '00'.repeat(32), sr.args.assertionId)
  const idUsed = await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'ASSERTION_IDENTIFIER' }), 'ASSERTION_IDENTIFIER')
  chk('market locked ASSERT_TRUTH at creation (Sepolia whitelist)', idUsed === b32('ASSERT_TRUTH'), idUsed)

  fs.writeFileSync(STATE, JSON.stringify({ market, factory, deployer, agentPk, relayPk,
    betId: bp.args.betId.toString(), quoted: curQ.toString(), stake: STAKE.toString(),
    seed: SEED.toString(), oldQuote: oldQuote.toString(), betBlock: B.toString(), oppBlock: OB.toString(),
    betTx: betRc.transactionHash, oppTx: oppRc.transactionHash, reqTx: reqRc.transactionHash,
    agentAddr: agent.address, relayAddr: relay.account.address, ownerAddr: owner.account.address,
    requestedAt: Number(blk.timestamp), assertionId: sr.args.assertionId }, null, 2))
  console.log('\nstate saved ->', STATE)
  console.log('\n=== PHASE 1 SUMMARY === pass=' + pass + ' fail=' + fail)
  console.log('\nWait ~2 hours (7200s UMA liveness), then run:  node sepolia-rehearsal.mjs phase2')
  if (fail) process.exit(1)
}

async function phase2() {
  console.log('=== PHASE 2 — execute settlement, agent self-claims ===')
  if (!fs.existsSync(STATE)) { console.error('No state file; run phase1 first.'); process.exit(1) }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const arts = compile(); const M = arts.SportsbookMarket.abi
  const agent = wal(st.agentPk)
  console.log('market:', st.market, ' agent:', agent.account.address)

  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - st.requestedAt
  console.log('elapsed since requestSettlement:', elapsed, 's (need >= 7200)')
  if (elapsed < 7200) { console.error('Liveness window not elapsed. Wait ' + (7200 - elapsed) + 's more.'); process.exit(1) }

  // Idempotent: if a previous run already executed settlement, do not try again
  // (it would revert MarketAlreadyEnded / NoActiveAssertion). Decode the historical
  // MarketSettled event instead so the assertions below still verify real data.
  const alreadySettled = await readRetry(
    () => pub.readContract({ address: st.market, abi: M, functionName: 'settled' }), 'settled')
  let ms
  if (alreadySettled) {
    console.log('  market already settled by a previous run — reading MarketSettled from logs')
    const logs = await pub.getLogs({ address: st.market, fromBlock: BigInt(st.oppBlock), toBlock: 'latest' })
    ms = parseEventLogs({ abi: M, logs }).find(l => l.eventName === 'MarketSettled')
  } else {
    const exRc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
      address: st.market, abi: M, functionName: 'executeSettlement' }) })
    console.log('  executeSettlement tx:', exRc.transactionHash, ' block:', exRc.blockNumber)
    ms = parseEventLogs({ abi: M, logs: exRc.logs }).find(l => l.eventName === 'MarketSettled')
  }
  chk('MarketSettled emitted via UMA oracle', !!ms && ms.args.viaOracle === true,
      ms ? 'finalSpread=' + ms.args.finalSpread + ' refundMode=' + ms.args.refundMode : 'none')

  const isSettled = await untilState('settled flag visible',
    () => pub.readContract({ address: st.market, abi: M, functionName: 'settled' }), v => v === true)
  chk('settled == true', isSettled === true, String(isSettled))
  const assertionActive = await readRetry(
    () => pub.readContract({ address: st.market, abi: M, functionName: 'assertionActive' }), 'assertionActive')
  chk('assertionActive cleared after settlement', assertionActive === false, String(assertionActive))
  const fs_ = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'finalSpread' }), 'finalSpread')
  chk('finalSpread recorded == proposed (0)', fs_ === 0n, String(fs_))

  // After settlement the market should hold exactly `distributable`: fees were swept at
  // placement, the UMA bond went back to the asserter, and the protocol seed was returned.
  const tPool = await pub.readContract({ address: st.market, abi: M, functionName: 'totalPool' })
  const sTot  = await pub.readContract({ address: st.market, abi: M, functionName: 'protocolSeedTotal' })
  const mBal  = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [st.market] })
  chk('protocol seed returned at settlement (market holds exactly distributable)',
      mBal === tPool - sTot, 'balance ' + f(mBal) + ' vs distributable ' + f(tPool - sTot))

  const erc = erc20
  // Agent pays its own gas to claim. Top up only if it has none — see the note in
  // phase1: the EIP-3009 bet is gasless for the agent, the claim is not.
  const agentGas = await readRetry(() => pub.getBalance({ address: agent.account.address }), 'agent ETH')
  if (agentGas === 0n) {
    console.log('  agent has no ETH for gas — funding from owner so it can claim for itself')
    await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({
      to: agent.account.address, value: 2000000000000000n }) })
    await untilState('agent gas visible', () => pub.getBalance({ address: agent.account.address }), v => v > 0n)
  }

  console.log('\nagent claiming its own payout (relay not involved)...')
  const clRc = await pub.waitForTransactionReceipt({ hash: await agent.writeContract({
    address: st.market, abi: M, functionName: 'claimPayout', args: [BigInt(st.betId)] }) })
  const pc = parseEventLogs({ abi: M, logs: clRc.logs }).find(l => l.eventName === 'PayoutClaimed')
  // Measure the delta at fixed blocks either side of the claim, not at "latest" —
  // a lagging node otherwise reports the pre-claim balance and the payout reads as 0.
  const CB = clRc.blockNumber
  await untilState('node caught up to claim block ' + CB, () => pub.getBlockNumber(), n => n >= CB)
  const balA = await readRetry(() => pub.readContract({ address: USDC, abi: erc, functionName: 'balanceOf', args: [agent.account.address], blockNumber: CB - 1n }), 'agent@pre')
  const balB = await readRetry(() => pub.readContract({ address: USDC, abi: erc, functionName: 'balanceOf', args: [agent.account.address], blockNumber: CB }), 'agent@post')
  const got = balB - balA
  console.log('  tx:', clRc.transactionHash, ' block:', CB, ' received:', f(got), 'USDC')
  chk('claim tx sender was the AGENT, not the relay',
      getAddress(clRc.from) === getAddress(agent.account.address), clRc.from)
  chk('relay is absent from the claim transaction',
      getAddress(clRc.from) !== getAddress(st.relayAddr), 'relay ' + st.relayAddr)
  chk('PayoutClaimed.bettor == agent', pc && getAddress(pc.args.bettor) === getAddress(agent.account.address))
  chk('PayoutClaimed.amount == USDC actually received', pc && pc.args.amount === got, f(got))
  chk('agent claimed its own payout directly', got > 0n, f(got))

  // Verify the realised payout against the contract's OWN settlement formula, read
  // from chain: payout = stake * (totalPool - protocolSeedTotal) / cachedWinningStakes.
  //
  // This replaces an earlier check of "realised == the phase1 getMarketEV quote".
  // That comparison was mis-specified for this run's ordering: here the agent bets
  // FIRST and the opposing bet lands after, so the phase1 quote prices a further
  // hypothetical bet on top of both, not the agent's already-placed one. (On the
  // fork the quote was taken before the agent's bet, which made the two coincide.)
  // A pre-bet quote answers "what if I bet now"; it cannot predict a final payout
  // once more stake arrives. Checking against the settlement formula is strictly
  // stronger — it validates the contract's real payout maths, not a coincidence.
  const cws = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'cachedWinningStakes' }), 'cachedWinningStakes')
  const betNow = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'getBet', args: [BigInt(st.betId)] }), 'getBet')
  const expected = cws > 0n ? (betNow.stake * (tPool - sTot)) / cws : 0n
  console.log('  settlement inputs: stake=' + f(betNow.stake) + ' distributable=' + f(tPool - sTot) +
              ' cachedWinningStakes=' + f(cws))
  chk('realised payout == contract settlement formula', got === expected, 'got ' + f(got) + ' expected ' + f(expected))
  chk('realised payout == exactly 2x stake (balanced book)', got === BigInt(st.stake) * 2n, f(got))
  chk('claimed bet is now marked claimed', betNow.claimed === true)

  console.log('\n  R6-4 (quote fix), from the phase1 snapshot at block ' + st.oppBlock + ':')
  console.log('    v1.10 getMarketEV currentPayout : ' + f(BigInt(st.quoted)))
  console.log('    v1.9 formula would have quoted  : ' + f(BigInt(st.oldQuote)))
  console.log('    (both price a further hypothetical stake at that pool state, not this bet)')

  console.log('\n=== PHASE 2 SUMMARY === pass=' + pass + ' fail=' + fail)
  if (fail) process.exit(1)
  console.log('\nLive Sepolia rehearsal COMPLETE. Record these tx hashes in the delta audit.')
}

/**
 * Re-verify a completed rehearsal from chain state alone. Sends no transactions and
 * needs no key material beyond the recorded addresses, so anyone can reproduce the
 * result independently. Every read is pinned to the block of the transaction it is
 * checking, which is what makes the numbers exact on a load-balanced RPC.
 */
async function verify() {
  console.log('=== VERIFY — re-reading the completed rehearsal from chain (no transactions) ===')
  if (!fs.existsSync(STATE)) { console.error('No state file.'); process.exit(1) }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const arts = compile(); const M = arts.SportsbookMarket.abi, F = arts.SportsbookFactory.abi
  const AG = getAddress(st.agentAddr), RL = getAddress(st.relayAddr), OW = getAddress(st.ownerAddr)
  const STK = BigInt(st.stake), SD = BigInt(st.seed), FEE = (STK * 200n) / 10000n
  console.log('market :', st.market)
  console.log('agent  :', AG, ' relay:', RL, ' owner:', OW)

  const at = (address, abi, functionName, args, blockNumber) =>
    readRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }), functionName)

  // --- deployed code ---
  for (const [n, a] of [['MarketDeployer', st.deployer], ['SportsbookFactory', st.factory], ['SportsbookMarket', st.market]]) {
    const code = await pub.getCode({ address: a })
    const size = code ? (code.length - 2) / 2 : 0
    const expected = n === 'SportsbookMarket' ? arts.SportsbookMarket.size : arts[n].size
    chk(n + ' on-chain runtime == compiled (' + expected + ' bytes)', size === expected, size + ' bytes')
    chk(n + ' under EIP-170', size <= 24576, size + ' <= 24576')
  }
  chk('factory.deployer() wired to MarketDeployer',
      getAddress(await at(st.factory, F, 'deployer', [], undefined)) === getAddress(st.deployer))
  chk('market ASSERTION_IDENTIFIER == ASSERT_TRUTH (Sepolia whitelist)',
      (await at(st.market, M, 'ASSERTION_IDENTIFIER', [], undefined)) === b32('ASSERT_TRUTH'))
  chk('market PROTOCOL_SEED == launch seed', (await at(st.market, M, 'PROTOCOL_SEED', [], undefined)) === SD, f(SD))

  // --- the placeBetFor transaction ---
  const betRc = await pub.getTransactionReceipt({ hash: st.betTx })
  const B = betRc.blockNumber, A = B - 1n
  const bp = parseEventLogs({ abi: M, logs: betRc.logs }).find(l => l.eventName === 'BetPlaced')
  chk('placeBetFor tx succeeded', betRc.status === 'success', betRc.status)
  chk('placeBetFor msg.sender was the RELAY', getAddress(betRc.from) === RL, betRc.from)
  chk('BetPlaced.bettor is the AGENT, not msg.sender', getAddress(bp.args.bettor) === AG, bp.args.bettor)
  chk('BetPlaced.stake == stake (fee excluded)', bp.args.stake === STK, f(bp.args.stake))
  chk('BetPlaced.fee == 2% of stake', bp.args.fee === FEE, f(bp.args.fee))
  const bet = await at(st.market, M, 'getBet', [BigInt(st.betId)], undefined)
  chk('stored bet.bettor is the AGENT', getAddress(bet.bettor) === AG, bet.bettor)

  // --- money movement across the bet block ---
  const d = async (addr) => (await at(USDC, erc20, 'balanceOf', [addr], B)) - (await at(USDC, erc20, 'balanceOf', [addr], A))
  chk('agent paid exactly stake + fee', (await d(AG)) === -(STK + FEE), f(await d(AG)))
  chk('relay USDC unchanged — never custodies', (await d(RL)) === 0n, f(await d(RL)))
  chk('owner received exactly the 2% fee', (await d(OW)) === FEE, f(await d(OW)))
  const dPool = (await at(st.market, M, 'greaterPool', [], B)) - (await at(st.market, M, 'greaterPool', [], A))
  const dTot  = (await at(st.market, M, 'totalPool', [], B)) - (await at(st.market, M, 'totalPool', [], A))
  chk('greaterPool rose by stake only', dPool === STK, f(dPool))
  chk('totalPool rose by stake only', dTot === STK, f(dTot))

  // --- settlement ---
  const logs = await pub.getLogs({ address: st.market, fromBlock: BigInt(st.betBlock), toBlock: 'latest' })
  const ev = parseEventLogs({ abi: M, logs })
  const ms = ev.find(l => l.eventName === 'MarketSettled')
  chk('MarketSettled via UMA oracle', !!ms && ms.args.viaOracle === true,
      ms ? 'finalSpread=' + ms.args.finalSpread + ' refundMode=' + ms.args.refundMode : 'none')
  chk('settled == true', (await at(st.market, M, 'settled', [], undefined)) === true)
  chk('assertionActive cleared', (await at(st.market, M, 'assertionActive', [], undefined)) === false)
  const tP = await at(st.market, M, 'totalPool', [], undefined)
  const sT = await at(st.market, M, 'protocolSeedTotal', [], undefined)
  const cw = await at(st.market, M, 'cachedWinningStakes', [], undefined)
  console.log('  settlement: totalPool=' + f(tP) + ' seedTotal=' + f(sT) + ' distributable=' + f(tP - sT) + ' winningStakes=' + f(cw))

  // --- the claim ---
  const pc = ev.find(l => l.eventName === 'PayoutClaimed')
  const clRc = await pub.getTransactionReceipt({ hash: pc.transactionHash })
  const CB = clRc.blockNumber
  chk('claim tx succeeded', clRc.status === 'success', clRc.status)
  chk('claim msg.sender was the AGENT itself', getAddress(clRc.from) === AG, clRc.from)
  chk('relay absent from the claim tx', getAddress(clRc.from) !== RL)
  chk('PayoutClaimed.bettor == agent', getAddress(pc.args.bettor) === AG)
  const expected = cw > 0n ? (bet.stake * (tP - sT)) / cw : 0n
  chk('PayoutClaimed.amount == settlement formula', pc.args.amount === expected, f(pc.args.amount) + ' vs ' + f(expected))
  chk('PayoutClaimed.amount == exactly 2x stake', pc.args.amount === STK * 2n, f(pc.args.amount))
  const agentDelta = (await at(USDC, erc20, 'balanceOf', [AG], CB)) - (await at(USDC, erc20, 'balanceOf', [AG], CB - 1n))
  chk('agent USDC actually increased by the payout', agentDelta === pc.args.amount, f(agentDelta))
  chk('bet marked claimed', bet.claimed === true)
  chk('market fully drained after claim', (await at(USDC, erc20, 'balanceOf', [st.market], CB)) === 0n)

  console.log('\n=== VERIFY SUMMARY === pass=' + pass + ' fail=' + fail)
  if (fail) process.exit(1)
}

const phase = process.argv[2]
if (phase === 'phase1') await phase1()
else if (phase === 'phase2') await phase2()
else if (phase === 'verify') await verify()
else { console.error('usage: sepolia-rehearsal.mjs phase1|phase2|verify'); process.exit(1) }
