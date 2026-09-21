#!/usr/bin/env node
/**
 * Base Sepolia live rehearsal for SportsbookMarket v1.11 / MarketDeployer v1.1 /
 * SportsbookFactory v1.6  —  the Even Steven v3 (claimPayoutFor) release.
 *
 * What this proves that the v1.10 rehearsal did not:
 *   the AGENT holds USDC and NOTHING ELSE. It signs an EIP-3009 authorization and
 *   signs nothing again. A separate RELAY submits placeBetFor AND claimPayoutFor.
 *   At the end the agent has been paid, and its ETH balance and transaction count
 *   are still exactly zero. Bet and claim, both gasless, both non-custodial.
 *
 * Two phases, because UMA liveness is 7200s of real time and cannot be fast-forwarded:
 *   node sepolia-rehearsal-v3.mjs phase1     # deploy -> bets -> requestSettlement
 *   ...wait ~2 hours...
 *   node sepolia-rehearsal-v3.mjs phase2     # executeSettlement -> relayed claim -> negatives
 *   node sepolia-rehearsal-v3.mjs verify     # re-read everything, no transactions
 * State is written to sepolia-rehearsal-v3-state.json between phases.
 *
 * COMPILER: solc 0.8.20+commit.a1b79de6, optimizer ON, runs=200, evmVersion shanghai.
 * runs=200 is the v3 decision; v1.10/v1.5 shipped at runs=1. The deployed runtime
 * sizes are asserted against the Gate 2b measurements, so a stray toolchain cannot
 * quietly substitute a different build.
 *
 * REQUIREMENTS
 *   env SEPOLIA_PRIVATE_KEY   owner / creator / asserter / opposing bettor.
 *                             Needs Base Sepolia ETH and >= ~103 testnet USDC
 *                             (100 of that is the UMA bond and comes back).
 *   env RELAY_PRIVATE_KEY     optional; a SEPARATE key that submits placeBetFor and
 *                             claimPayoutFor. Defaults to a generated key auto-funded
 *                             with ETH from the owner. It must NOT be the agent.
 *   env OPPOSING_PRIVATE_KEY  optional; defaults to the owner key.
 *   env STAKE_USDC            optional, default 1 (the contract minimum).
 *   env SEED_USDC             optional, default 1 — per-side protocol seed.
 *
 * TWO TESTNET-SPECIFIC FACTS THIS SCRIPT HANDLES FOR YOU — both verified on-chain:
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
         encodeAbiParameters, parseEventLogs, formatUnits, getAddress, padHex,
         encodeFunctionData, toHex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { loadEnv, envSearchList } from './env-resolve.mjs'

const HERE      = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS = path.resolve(HERE, '../contracts')
const STATE     = path.resolve(HERE, 'sepolia-rehearsal-v3-state.json')
// Same env resolution as every script here: $EVEN_STEVEN_ENV, then ~/.even-steven/.env,
// then scripts/.env. Key material should not live under ~/Desktop (iCloud-synced).
const ENVFILE   = loadEnv(HERE)

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const OO   = '0x0F7fC5E6482f096380db6158f978167b57388deE'
const RPC  = process.env.SEPOLIA_RPC || 'https://sepolia.base.org'
const STAKE = BigInt(Math.round(Number(process.env.STAKE_USDC || '1') * 1e6))
const SEED  = BigInt(Math.round(Number(process.env.SEED_USDC  || '1') * 1e6))
const f = v => formatUnits(v, 6)
const b32 = s => padHex(stringToHex(s), { size: 32, dir: 'right' })

// Measured at Gate 2b: solc 0.8.20+commit.a1b79de6, optimizer on, runs=200, shanghai.
const EXPECTED_SIZE = { SportsbookMarket: 17700, MarketDeployer: 19091, SportsbookFactory: 8085 }

const onErr = e => {
  console.error('\n!! ERROR: ' + ((e.shortMessage || e.message || '').split('\n')[0]))
  if (e.details) console.error('   details: ' + e.details)
  if (e.metaMessages) console.error('   ' + e.metaMessages.slice(0, 3).join(' | '))
  console.error('   (state, if any, is in ' + STATE + ')')
  process.exit(1)
}
process.on('unhandledRejection', onErr)
process.on('uncaughtException', onErr)

/** See the v1.10 rehearsal: public Sepolia RPCs load-balance, so poll for code. */
async function waitForCode(addr, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const code = await pub.getCode({ address: addr }).catch(() => undefined)
    if (code && code !== '0x') return (code.length - 2) / 2
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('no code at ' + addr + ' (' + label + ') after ' + (tries * 2) + 's')
}

/** Poll until a write's effect is visible (R6-10). Asserts nothing on its own. */
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

/**
 * Raw eth_call returning the node's revert bytes verbatim.
 *
 * viem wraps revert data in several error shapes and can drop the raw bytes
 * entirely, so a live negative that asserts on a 4-byte selector has to read what
 * the node actually returned rather than what a client library reconstructed.
 */
async function rawCall(to, data, from) {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call',
                 params: [{ ...(from ? { from } : {}), to, data }, 'latest'] }
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
                                 body: JSON.stringify(body) })
  const j = await res.json()
  if (j.error) {
    const d = j.error.data
    const raw = typeof d === 'string' ? d : (d && typeof d.data === 'string' ? d.data : null)
    return { ok: false, data: raw, message: j.error.message }
  }
  return { ok: true, data: j.result ?? '0x' }
}

const SEL = sig => keccak256(stringToHex(sig)).slice(0, 10)
const ERRSEL = {
  AlreadyClaimed: SEL('AlreadyClaimed()'), NotYourBet: SEL('NotYourBet()'),
  NothingToClaim: SEL('NothingToClaim()'), InvalidBetId: SEL('InvalidBetId()'),
  NoPayout: SEL('NoPayout()'), NotOwner: SEL('NotOwner()'), MarketPaused: SEL('MarketPaused()'),
}

let pass = 0, fail = 0
const chk = (l, c, d = '') => { c ? (pass++, console.log('  PASS  ' + l + (d ? '  [' + d + ']' : '')))
                                  : (fail++, console.log('  FAIL  ' + l + '  [' + d + ']')) }

if (!process.env.SEPOLIA_PRIVATE_KEY && process.argv[2] !== 'sizes') {
  console.error('SEPOLIA_PRIVATE_KEY is required.')
  console.error(ENVFILE
    ? '  ' + ENVFILE + ' was loaded but does not define SEPOLIA_PRIVATE_KEY.'
    : '  No env file found. Looked in:\n    ' + envSearchList(HERE) +
      '\n  Create one of those, or export the variable.')
  process.exit(1)
}
if (process.env.SEPOLIA_PRIVATE_KEY) {
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
const owner = process.env.SEPOLIA_PRIVATE_KEY ? wal(process.env.SEPOLIA_PRIVATE_KEY) : null

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function name() view returns (string)',
])

function compile() {
  const files = ['SportsbookMarket-v1_11.sol', 'MarketDeployer-v1_1.sol', 'SportsbookFactory-v1_6.sol']
  const sources = {}
  for (const f of files) sources[f] = { content: fs.readFileSync(path.join(CONTRACTS, f), 'utf8') }
  const ozRoots = [ path.resolve(HERE, 'node_modules/@openzeppelin/contracts'),
                    path.resolve(HERE, '../node_modules/@openzeppelin/contracts'),
                    path.resolve(HERE, 'fork-tests/node_modules/@openzeppelin/contracts'),
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
  // v3 SHIPS AT runs=200. Do not "tidy" this back to 1 — the sizes asserted below,
  // and the ones in v1.11-mainnet-plan.md, are all measured at 200.
  const input = { language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } } } }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))
  const errs = (out.errors || []).filter(e => e.severity === 'error')
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); process.exit(1) }
  const arts = {}
  for (const fl of Object.keys(out.contracts))
    for (const [n, c] of Object.entries(out.contracts[fl]))
      if (c.evm.bytecode.object) arts[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
                                             size: c.evm.deployedBytecode.object.length / 2 }
  if (!solc.version().startsWith('0.8.20+commit.a1b79de6')) {
    console.error('  ABORT: solc is ' + solc.version() + ', plan requires 0.8.20+commit.a1b79de6')
    process.exit(1)
  }
  return arts
}

/** Assert compiled sizes against the Gate 2b measurements before anything is deployed. */
function assertSizes(arts) {
  console.log('  solc ' + solc.version() + ', optimizer on runs=200, EVM shanghai')
  for (const [n, want] of Object.entries(EXPECTED_SIZE)) {
    const got = arts[n].size
    chk(n + ' compiled runtime == ' + want + ' bytes (Gate 2b measurement)', got === want, got + ' bytes')
    chk(n + ' under EIP-170', got <= 24576, got + ' <= 24576')
  }
}

/** The agent must never spend gas and never send a transaction. Re-asserted at every step. */
async function assertAgentUntouched(agentAddr, label) {
  const eth = await readRetry(() => pub.getBalance({ address: agentAddr }), 'agent ETH')
  const txc = await readRetry(() => pub.getTransactionCount({ address: agentAddr }), 'agent nonce')
  chk('AGENT ETH balance == 0 (' + label + ')', eth === 0n, eth + ' wei')
  chk('AGENT transaction count == 0 (' + label + ')', txc === 0, String(txc))
}

async function phase1() {
  console.log('=== PHASE 1 — deploy v1.11/v1.1/v1.6, relayed bet, request settlement ===')
  console.log('owner/asserter/opposing:', owner.account.address)
  const arts = compile()
  assertSizes(arts)

  const bal = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [owner.account.address] })
  console.log('owner USDC balance:', f(bal))
  // 100 USDC UMA bond (returned) + agent stake+fee (sent to the agent) + opposing
  // stake+fee + the two-sided seed
  const cost   = STAKE + (STAKE * 200n) / 10000n
  const needed = 100000000n + cost * 2n + SEED * 2n
  if (bal < needed) { console.error('Insufficient testnet USDC. Need ~' + f(needed) + ', have ' + f(bal) +
    '\n(100 USDC of that is the UMA bond and is returned after settlement.)'); process.exit(1) }

  // ---- step 1: deploy MarketDeployer v1.1 -> SportsbookFactory v1.6 ----
  const dep = async (n, args = []) => {
    const h = await owner.deployContract({ abi: arts[n].abi, bytecode: arts[n].bytecode, args })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    const onchain = await waitForCode(r.contractAddress, n)
    console.log('  deployed ' + n + ' -> ' + r.contractAddress + '  (tx ' + h + ')')
    console.log('    block ' + r.blockNumber + ', gas ' + r.gasUsed + ', on-chain runtime ' + onchain + ' bytes')
    chk(n + ' ON-CHAIN runtime == ' + EXPECTED_SIZE[n] + ' bytes', onchain === EXPECTED_SIZE[n], onchain + ' bytes')
    return { addr: r.contractAddress, tx: h, block: r.blockNumber, gas: r.gasUsed }
  }
  const deployer = await dep('MarketDeployer')
  const factory  = await dep('SportsbookFactory', [USDC, OO, deployer.addr])
  const F = arts.SportsbookFactory.abi, M = arts.SportsbookMarket.abi

  // BEFORE ANY OTHER CALL: the factory must be wired to the deployer we just deployed.
  const wiredDeployer = await readRetry(
    () => pub.readContract({ address: factory.addr, abi: F, functionName: 'deployer' }), 'factory.deployer()')
  chk('factory.deployer() matches deployed MarketDeployer (checked before anything else)',
      getAddress(wiredDeployer) === getAddress(deployer.addr), wiredDeployer)

  // TESTNET ONLY — ASSERT_TRUTH2 is not whitelisted on Base Sepolia.
  console.log('\nsetting settlementIdentifier to ASSERT_TRUTH (Sepolia only — never on mainnet)...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: factory.addr, abi: F, functionName: 'setSettlementIdentifier', args: [b32('ASSERT_TRUTH')] }) })
  const sid = await untilState('settlementIdentifier visible',
    () => pub.readContract({ address: factory.addr, abi: F, functionName: 'settlementIdentifier' }),
    v => v === b32('ASSERT_TRUTH'))
  chk('settlementIdentifier == ASSERT_TRUTH', sid === b32('ASSERT_TRUTH'), sid)

  if (SEED > 0n) {
    console.log('\napproving factory for USDC (seed pull)...')
    await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
      address: USDC, abi: erc20, functionName: 'approve', args: [factory.addr, 2n ** 256n - 1n] }) })
    await untilState('factory allowance visible',
      () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [owner.account.address, factory.addr] }),
      v => v > 0n)
  }

  // ---- step 2: createMarket through the factory ----
  const gameId = 'NFL-2026-09-21-HOME-RehearsalV3-AWAY-Sepolia-' + Date.now()
  console.log('\ncreating market (seed ' + f(SEED) + ' USDC/side):', gameId)
  const rc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: factory.addr, abi: F, functionName: 'createMarket', args: [gameId, -35000n, SEED] }) })
  const mc = parseEventLogs({ abi: F, logs: rc.logs }).find(l => l.eventName === 'MarketCreated')
  const market = mc.args.market
  console.log('  market ->', market, ' (tx ' + rc.transactionHash + ')')
  const marketSize = await waitForCode(market, 'SportsbookMarket')
  chk('SportsbookMarket ON-CHAIN runtime == ' + EXPECTED_SIZE.SportsbookMarket + ' bytes',
      marketSize === EXPECTED_SIZE.SportsbookMarket, marketSize + ' bytes')
  chk('PROTOCOL_SEED matches requested seed',
      await pub.readContract({ address: market, abi: M, functionName: 'PROTOCOL_SEED' }) === SEED, f(SEED))
  chk('protocolSeedTotal == 2x per-side seed',
      await pub.readContract({ address: market, abi: M, functionName: 'protocolSeedTotal' }) === SEED * 2n)
  chk('market owner is the creator', getAddress(await pub.readContract({ address: market, abi: M, functionName: 'owner' }))
      === getAddress(owner.account.address))

  // ---- step 3: AGENT = brand-new key, funded with USDC ONLY ----
  const agentPk = generatePrivateKey(), agent = privateKeyToAccount(agentPk)
  const relayPk = process.env.RELAY_PRIVATE_KEY || generatePrivateKey()
  const relay = wal(relayPk)
  console.log('\nagent (signs, never sends):', agent.address)
  console.log('relay (submits everything):', relay.account.address)
  chk('relay is NOT the agent', getAddress(relay.account.address) !== getAddress(agent.address))

  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
    address: USDC, abi: erc20, functionName: 'transfer', args: [agent.address, cost] }) })
  await untilState('agent USDC funding visible',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [agent.address] }),
    v => v >= cost)
  console.log('  agent funded with', f(cost), 'USDC and NO ETH')
  await assertAgentUntouched(agent.address, 'after USDC funding')

  if (!process.env.RELAY_PRIVATE_KEY) {
    await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({
      to: relay.account.address, value: 4000000000000000n }) })
    await untilState('relay gas funding visible',
      () => pub.getBalance({ address: relay.account.address }), v => v > 0n)
  }

  // ---- step 4: AGENT signs EIP-3009; RELAY submits placeBetFor ----
  const tokenName = await pub.readContract({ address: USDC, abi: erc20, functionName: 'name' })
  console.log('\nUSDC name() on this network:', JSON.stringify(tokenName))
  const domain = { name: tokenName, version: '2', chainId: 84532, verifyingContract: USDC }
  const types = { ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }
  const salt = keccak256(stringToHex('rehearsal-v3-' + Date.now()))
  const greaterThan = true
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
  const blk = await pub.getBlock()
  const validBefore = blk.timestamp + 7200n
  const sig = await agent.signTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization',
    message: { from: agent.address, to: market, value: cost, validAfter: 0n, validBefore, nonce } })
  const auth = { validAfter: 0n, validBefore, nonce, salt,
                 v: parseInt(sig.slice(130, 132), 16), r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130) }

  console.log('\nrelay submitting placeBetFor (agent signs, agent sends nothing)...')
  const betRc = await pub.waitForTransactionReceipt({ hash: await relay.writeContract({
    address: market, abi: M, functionName: 'placeBetFor', args: [agent.address, greaterThan, STAKE, auth] }) })
  const bp = parseEventLogs({ abi: M, logs: betRc.logs }).find(l => l.eventName === 'BetPlaced')
  console.log('  tx:', betRc.transactionHash, ' gas:', betRc.gasUsed, ' block:', betRc.blockNumber)
  console.log('  BetPlaced decoded:', JSON.stringify({ bettor: bp.args.bettor, betId: bp.args.betId.toString(),
    stake: f(bp.args.stake), fee: f(bp.args.fee), greaterThan: bp.args.greaterThan, lockedZ: bp.args.lockedZ.toString() }))
  chk('placeBetFor msg.sender was the RELAY', getAddress(betRc.from) === getAddress(relay.account.address), betRc.from)
  chk('BetPlaced.bettor == AGENT (signer), not the relay',
      getAddress(bp.args.bettor) === getAddress(agent.address), bp.args.bettor)
  await assertAgentUntouched(agent.address, 'after the relayed bet')

  // Pin before/after reads to explicit blocks (R6-10): on a load-balanced RPC
  // "latest" is whatever node answers, which makes a delta meaningless.
  const B = betRc.blockNumber, A = betRc.blockNumber - 1n
  await untilState('node caught up to bet block ' + B, () => pub.getBlockNumber(), n => n >= B)
  const readAt = (address, abi, functionName, args, blockNumber) =>
    readRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }),
              functionName + '@' + blockNumber)

  const bet0 = await readAt(market, M, 'getBet', [bp.args.betId], B)
  chk('stored bet.bettor == AGENT (msg.sender was the relay)',
      getAddress(bet0.bettor) === getAddress(agent.address), bet0.bettor)
  chk('stored bet.stake is stake only, fee excluded', bet0.stake === STAKE, f(bet0.stake))
  const relayD = (await readAt(USDC, erc20, 'balanceOf', [relay.account.address], B)) -
                 (await readAt(USDC, erc20, 'balanceOf', [relay.account.address], A))
  chk('relay USDC unchanged across placeBetFor (never custodies)', relayD === 0n, f(relayD))
  const agentD = (await readAt(USDC, erc20, 'balanceOf', [agent.address], B)) -
                 (await readAt(USDC, erc20, 'balanceOf', [agent.address], A))
  chk('agent paid exactly stake + fee', -agentD === cost, f(-agentD))

  // ---- step 5: opposing bet, close, request settlement ----
  const opposing = process.env.OPPOSING_PRIVATE_KEY ? wal(process.env.OPPOSING_PRIVATE_KEY) : owner
  console.log('\nplacing opposing bet (' + (process.env.OPPOSING_PRIVATE_KEY ? 'separate wallet' : 'owner') + ', normal placeBet)...')
  await pub.waitForTransactionReceipt({ hash: await opposing.writeContract({
    address: USDC, abi: erc20, functionName: 'approve', args: [market, 2n ** 256n - 1n] }) })
  await untilState('market allowance visible (opposing bet)',
    () => pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [opposing.account.address, market] }),
    v => v > 0n)
  const oppRc = await pub.waitForTransactionReceipt({ hash: await opposing.writeContract({
    address: market, abi: M, functionName: 'placeBet', args: [false, STAKE] }) })
  const oppBp = parseEventLogs({ abi: M, logs: oppRc.logs }).find(l => l.eventName === 'BetPlaced')
  const OB = oppRc.blockNumber
  await untilState('node caught up to opposing-bet block ' + OB, () => pub.getBlockNumber(), n => n >= OB)
  console.log('  opposing bet tx:', oppRc.transactionHash, ' block:', OB, ' betId:', oppBp.args.betId.toString())

  console.log('\nclosing betting and requesting settlement (finalSpread = 0)...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: market, abi: M, functionName: 'closeBetting' }) })
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
  chk('SettlementRequested.asserter == owner', getAddress(sr.args.asserter) === getAddress(owner.account.address))
  chk('assertionId is non-zero', sr.args.assertionId !== '0x' + '00'.repeat(32), sr.args.assertionId)
  chk('market locked ASSERT_TRUTH at creation (Sepolia whitelist)',
      (await readRetry(() => pub.readContract({ address: market, abi: M, functionName: 'ASSERTION_IDENTIFIER' }), 'id'))
      === b32('ASSERT_TRUTH'))
  await assertAgentUntouched(agent.address, 'after requestSettlement')

  const reqBlk = await pub.getBlock({ blockNumber: reqRc.blockNumber })
  fs.writeFileSync(STATE, JSON.stringify({
    market, factory: factory.addr, deployer: deployer.addr, agentPk, relayPk,
    betId: bp.args.betId.toString(), oppBetId: oppBp.args.betId.toString(),
    stake: STAKE.toString(), seed: SEED.toString(), cost: cost.toString(),
    betBlock: B.toString(), oppBlock: OB.toString(),
    deployerTx: deployer.tx, factoryTx: factory.tx, createTx: rc.transactionHash,
    betTx: betRc.transactionHash, oppTx: oppRc.transactionHash, reqTx: reqRc.transactionHash,
    agentAddr: agent.address, relayAddr: relay.account.address, ownerAddr: owner.account.address,
    opposingAddr: opposing.account.address,
    requestedAt: Number(reqBlk.timestamp), assertionId: sr.args.assertionId, gameId,
  }, null, 2))
  console.log('\nstate saved ->', STATE)
  console.log('\n=== PHASE 1 SUMMARY === pass=' + pass + ' fail=' + fail)
  console.log('\nWait ~2 hours (7200s UMA liveness), then run:  node sepolia-rehearsal-v3.mjs phase2')
  if (fail) process.exit(1)
}

async function phase2() {
  console.log('=== PHASE 2 — settle, RELAYED claim, live negatives ===')
  if (!fs.existsSync(STATE)) { console.error('No state file; run phase1 first.'); process.exit(1) }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const arts = compile(); const M = arts.SportsbookMarket.abi
  assertSizes(arts)
  const relay = wal(st.relayPk)
  const AG = getAddress(st.agentAddr), RL = getAddress(st.relayAddr)
  console.log('market:', st.market, ' agent:', AG, ' relay:', RL)
  await assertAgentUntouched(AG, 'start of phase2')

  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - st.requestedAt
  console.log('elapsed since requestSettlement:', elapsed, 's (need >= 7200)')
  if (elapsed < 7200) { console.error('Liveness window not elapsed. Wait ' + (7200 - elapsed) + 's more.'); process.exit(1) }

  // ---- step 5 (cont.): executeSettlement, decode SettlementDetails + MarketSettled ----
  const alreadySettled = await readRetry(
    () => pub.readContract({ address: st.market, abi: M, functionName: 'settled' }), 'settled')
  let ms, sd, exTx = null
  if (alreadySettled) {
    console.log('  market already settled by a previous run — reading the events from logs')
    const logs = await pub.getLogs({ address: st.market, fromBlock: BigInt(st.oppBlock), toBlock: 'latest' })
    const ev = parseEventLogs({ abi: M, logs })
    ms = ev.find(l => l.eventName === 'MarketSettled'); sd = ev.find(l => l.eventName === 'SettlementDetails')
    exTx = ms?.transactionHash
  } else {
    const exRc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({
      address: st.market, abi: M, functionName: 'executeSettlement' }) })
    exTx = exRc.transactionHash
    console.log('  executeSettlement tx:', exTx, ' block:', exRc.blockNumber, ' gas:', exRc.gasUsed)
    const ev = parseEventLogs({ abi: M, logs: exRc.logs })
    ms = ev.find(l => l.eventName === 'MarketSettled'); sd = ev.find(l => l.eventName === 'SettlementDetails')
  }
  chk('MarketSettled emitted via UMA oracle', !!ms && ms.args.viaOracle === true,
      ms ? 'finalSpread=' + ms.args.finalSpread + ' refundMode=' + ms.args.refundMode : 'none')
  chk('SettlementDetails emitted (NEW in v1.11)', !!sd,
      sd ? 'distributable=' + f(sd.args.distributable) + ' winningStakes=' + f(sd.args.winningStakes) : 'none')
  chk('SettlementDetails precedes MarketSettled in the same tx',
      !!sd && !!ms && sd.transactionHash === ms.transactionHash && sd.logIndex < ms.logIndex,
      sd && ms ? 'logIndex ' + sd.logIndex + ' < ' + ms.logIndex : 'n/a')

  const settleBlock = ms.blockNumber
  const tPool = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'totalPool', blockNumber: settleBlock }), 'totalPool')
  const sTot  = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'protocolSeedTotal', blockNumber: settleBlock }), 'protocolSeedTotal')
  const cws   = await readRetry(() => pub.readContract({ address: st.market, abi: M, functionName: 'cachedWinningStakes', blockNumber: settleBlock }), 'cachedWinningStakes')
  chk('SettlementDetails.distributable == totalPool - protocolSeedTotal (on-chain, settlement block)',
      sd.args.distributable === tPool - sTot, f(sd.args.distributable) + ' vs ' + f(tPool - sTot))
  chk('SettlementDetails.winningStakes == cachedWinningStakes (on-chain, settlement block)',
      sd.args.winningStakes === cws, f(sd.args.winningStakes) + ' vs ' + f(cws))
  const mBal = await readRetry(() => pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [st.market], blockNumber: settleBlock }), 'market bal')
  chk('protocol seed returned at settlement (market holds exactly distributable)',
      mBal === tPool - sTot, 'balance ' + f(mBal) + ' vs distributable ' + f(tPool - sTot))
  await assertAgentUntouched(AG, 'after settlement')

  // ---- step 6: RELAY submits claimPayoutFor. The agent signs and sends NOTHING. ----
  console.log('\nRELAY submitting claimPayoutFor(AGENT, [' + st.betId + ']) — agent signs nothing...')
  const clRc = await pub.waitForTransactionReceipt({ hash: await relay.writeContract({
    address: st.market, abi: M, functionName: 'claimPayoutFor', args: [AG, [BigInt(st.betId)]] }) })
  const CB = clRc.blockNumber
  await untilState('node caught up to claim block ' + CB, () => pub.getBlockNumber(), n => n >= CB)
  const cev = parseEventLogs({ abi: M, logs: clRc.logs })
  const pc = cev.find(l => l.eventName === 'PayoutClaimed')
  const bc = cev.find(l => l.eventName === 'BetClaimed')
  console.log('  tx:', clRc.transactionHash, ' block:', CB, ' gas:', clRc.gasUsed)
  console.log('  PayoutClaimed:', JSON.stringify({ bettor: pc.args.bettor, amount: f(pc.args.amount) }))
  console.log('  BetClaimed   :', JSON.stringify({ bettor: bc.args.bettor, betId: bc.args.betId.toString(), payout: f(bc.args.payout) }))

  chk('claim tx.from == RELAY', getAddress(clRc.from) === RL, clRc.from)
  chk('claim tx.to == market', getAddress(clRc.to) === getAddress(st.market), clRc.to)
  chk('claim tx.from is NOT the agent', getAddress(clRc.from) !== AG)
  chk('PayoutClaimed.bettor == AGENT', getAddress(pc.args.bettor) === AG, pc.args.bettor)
  chk('BetClaimed.bettor == AGENT', getAddress(bc.args.bettor) === AG, bc.args.bettor)
  chk('BetClaimed.betId == the agent bet', bc.args.betId === BigInt(st.betId), bc.args.betId.toString())
  chk('BetClaimed.payout == PayoutClaimed.amount (single bet)', bc.args.payout === pc.args.amount, f(bc.args.payout))

  // USDC Transfer market -> agent of exactly that amount, from the receipt itself
  const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
  const xfers = clRc.logs.filter(l => getAddress(l.address) === getAddress(USDC) && l.topics[0] === TRANSFER)
  chk('exactly one USDC Transfer in the claim tx', xfers.length === 1, String(xfers.length))
  chk('USDC Transfer from == market', getAddress('0x' + xfers[0].topics[1].slice(26)) === getAddress(st.market))
  chk('USDC Transfer to == AGENT', getAddress('0x' + xfers[0].topics[2].slice(26)) === AG)
  chk('USDC Transfer amount == PayoutClaimed.amount', BigInt(xfers[0].data) === pc.args.amount, f(BigInt(xfers[0].data)))

  const at = (address, abi, functionName, args, blockNumber) =>
    readRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }), functionName + '@' + blockNumber)
  const agentPre  = await at(USDC, erc20, 'balanceOf', [AG], CB - 1n)
  const agentPost = await at(USDC, erc20, 'balanceOf', [AG], CB)
  const relayPre  = await at(USDC, erc20, 'balanceOf', [RL], CB - 1n)
  const relayPost = await at(USDC, erc20, 'balanceOf', [RL], CB)
  console.log('\n  pinned-block balance table (claim block ' + CB + '):')
  console.log('    account   before(' + (CB - 1n) + ')    after(' + CB + ')      delta')
  console.log('    AGENT     ' + f(agentPre).padStart(12) + ' ' + f(agentPost).padStart(12) + ' ' + f(agentPost - agentPre).padStart(12))
  console.log('    RELAY     ' + f(relayPre).padStart(12) + ' ' + f(relayPost).padStart(12) + ' ' + f(relayPost - relayPre).padStart(12))
  console.log('    MARKET    ' + f(await at(USDC, erc20, 'balanceOf', [st.market], CB - 1n)).padStart(12) + ' ' +
              f(await at(USDC, erc20, 'balanceOf', [st.market], CB)).padStart(12))
  chk('AGENT USDC delta == +PayoutClaimed.amount', agentPost - agentPre === pc.args.amount, f(agentPost - agentPre))
  chk('RELAY USDC delta == 0 (relay never custodies the payout)', relayPost - relayPre === 0n, f(relayPost - relayPre))
  chk('market fully drained after the claim', (await at(USDC, erc20, 'balanceOf', [st.market], CB)) === 0n)
  chk('realised payout == exactly 2x stake', pc.args.amount === BigInt(st.stake) * 2n, f(pc.args.amount))
  chk('bet is now marked claimed', (await at(st.market, M, 'getBet', [BigInt(st.betId)], CB)).claimed === true)

  // THE HEADLINE CLAIM
  console.log('\n  --- headline: bet AND claim with zero ETH and zero transactions ---')
  await assertAgentUntouched(AG, 'AFTER being paid')

  // ---- step 7: reconstruct the payout from logs alone ----
  const logsAll = await pub.getLogs({ address: st.market, fromBlock: BigInt(st.betBlock), toBlock: CB })
  const evAll = parseEventLogs({ abi: M, logs: logsAll })
  const bpLog = evAll.filter(l => l.eventName === 'BetPlaced').find(l => l.args.betId === BigInt(st.betId))
  const sdLog = evAll.find(l => l.eventName === 'SettlementDetails')
  const msLog = evAll.find(l => l.eventName === 'MarketSettled')
  const scaled = msLog.args.finalSpread * 10000n
  const isWinner = bpLog.args.greaterThan ? scaled > bpLog.args.lockedZ : scaled <= bpLog.args.lockedZ
  const fromLogs = msLog.args.refundMode ? bpLog.args.stake
                 : (isWinner ? (bpLog.args.stake * sdLog.args.distributable) / sdLog.args.winningStakes : 0n)
  console.log('  log-only reconstruction: stake=' + f(bpLog.args.stake) + ' lockedZ=' + bpLog.args.lockedZ +
              ' finalSpread=' + msLog.args.finalSpread + ' distributable=' + f(sdLog.args.distributable) +
              ' winningStakes=' + f(sdLog.args.winningStakes) + ' -> ' + f(fromLogs))
  chk('payout computed from EVENTS ALONE == USDC actually received',
      fromLogs === agentPost - agentPre, f(fromLogs) + ' vs ' + f(agentPost - agentPre))

  // ---- step 8: live negatives via raw eth_call ----
  console.log('\n--- live negatives (raw eth_call, decoded revert selectors) ---')
  const neg = async (label, fn, args, wantSel, from = RL) => {
    const r = await rawCall(st.market, encodeFunctionData({ abi: M, functionName: fn, args }), from)
    const got = r.ok ? 'NO REVERT (call succeeded)' : String(r.data).slice(0, 10)
    chk(label, !r.ok && got === wantSel, got + (r.ok ? '' : ' expected ' + wantSel))
  }
  await neg('repeat claimPayoutFor(AGENT,[betId]) -> AlreadyClaimed',
            'claimPayoutFor', [AG, [BigInt(st.betId)]], ERRSEL.AlreadyClaimed)
  await neg('claimPayoutFor(RELAY,[betId]) -> NotYourBet',
            'claimPayoutFor', [RL, [BigInt(st.betId)]], ERRSEL.NotYourBet)
  await neg('claimPayoutFor(AGENT,[]) -> NothingToClaim',
            'claimPayoutFor', [AG, []], ERRSEL.NothingToClaim)
  await neg('claimPayoutFor(AGENT,[99]) -> InvalidBetId',
            'claimPayoutFor', [AG, [99n]], ERRSEL.InvalidBetId)
  await neg('claimPayoutFor(loser,[oppBetId]) -> NoPayout',
            'claimPayoutFor', [getAddress(st.opposingAddr), [BigInt(st.oppBetId)]], ERRSEL.NoPayout)
  await neg('non-owner closeBetting() -> NotOwner (C1)',
            'closeBetting', [], ERRSEL.NotOwner)

  console.log('\n  owner pausing the market to prove MarketPaused() on the live network...')
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: st.market, abi: M, functionName: 'pause' }) })
  await untilState('paused visible', () => pub.readContract({ address: st.market, abi: M, functionName: 'paused' }), v => v === true)
  await neg('placeBet while paused -> MarketPaused (C1)', 'placeBet', [true, STAKE], ERRSEL.MarketPaused)
  const dummyAuth = { validAfter: 0n, validBefore: 2n ** 48n, nonce: keccak256(stringToHex('x')),
                      salt: keccak256(stringToHex('x')), v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }
  await neg('placeBetFor while paused -> MarketPaused (C1)',
            'placeBetFor', [AG, true, STAKE, dummyAuth], ERRSEL.MarketPaused)
  await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: st.market, abi: M, functionName: 'unpause' }) })
  await untilState('unpaused visible', () => pub.readContract({ address: st.market, abi: M, functionName: 'paused' }), v => v === false)
  chk('market unpaused again', (await pub.readContract({ address: st.market, abi: M, functionName: 'paused' })) === false)

  await assertAgentUntouched(AG, 'end of phase2')

  st.claimTx = clRc.transactionHash; st.exTx = exTx; st.claimBlock = CB.toString()
  st.payout = pc.args.amount.toString(); st.settleBlock = settleBlock.toString()
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2))
  console.log('\n=== PHASE 2 SUMMARY === pass=' + pass + ' fail=' + fail)
  if (fail) process.exit(1)
  console.log('\nLive Sepolia v3 rehearsal COMPLETE. Record these tx hashes in the delta audit.')
}

/**
 * Re-verify the completed rehearsal from chain state alone. Sends no transactions.
 * Every read is pinned to the block of the transaction it is checking.
 */
async function verify() {
  console.log('=== VERIFY — re-reading the completed v3 rehearsal from chain (no transactions) ===')
  if (!fs.existsSync(STATE)) { console.error('No state file.'); process.exit(1) }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const arts = compile(); const M = arts.SportsbookMarket.abi, F = arts.SportsbookFactory.abi
  const AG = getAddress(st.agentAddr), RL = getAddress(st.relayAddr), OW = getAddress(st.ownerAddr)
  const STK = BigInt(st.stake), SD = BigInt(st.seed), FEE = (STK * 200n) / 10000n
  console.log('market :', st.market)
  console.log('agent  :', AG, ' relay:', RL, ' owner:', OW)

  const at = (address, abi, functionName, args, blockNumber) =>
    readRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }), functionName)

  // --- deployed code, against the Gate 2b sizes ---
  for (const [n, a] of [['MarketDeployer', st.deployer], ['SportsbookFactory', st.factory], ['SportsbookMarket', st.market]]) {
    const code = await pub.getCode({ address: a })
    const size = code ? (code.length - 2) / 2 : 0
    chk(n + ' on-chain runtime == ' + EXPECTED_SIZE[n] + ' bytes (runs=200)', size === EXPECTED_SIZE[n], size + ' bytes')
    chk(n + ' on-chain runtime == compiled', size === arts[n].size, size + ' vs ' + arts[n].size)
    chk(n + ' under EIP-170', size <= 24576, size + ' <= 24576')
  }
  chk('factory.deployer() wired to MarketDeployer',
      getAddress(await at(st.factory, F, 'deployer', [], undefined)) === getAddress(st.deployer))
  chk('market ASSERTION_IDENTIFIER == ASSERT_TRUTH (Sepolia whitelist)',
      (await at(st.market, M, 'ASSERTION_IDENTIFIER', [], undefined)) === b32('ASSERT_TRUTH'))
  chk('market PROTOCOL_SEED == launch seed', (await at(st.market, M, 'PROTOCOL_SEED', [], undefined)) === SD, f(SD))

  // --- the relayed bet ---
  const betRc = await pub.getTransactionReceipt({ hash: st.betTx })
  const B = betRc.blockNumber, A = B - 1n
  const bp = parseEventLogs({ abi: M, logs: betRc.logs }).find(l => l.eventName === 'BetPlaced')
  chk('placeBetFor tx succeeded', betRc.status === 'success', betRc.status)
  chk('placeBetFor msg.sender was the RELAY', getAddress(betRc.from) === RL, betRc.from)
  chk('BetPlaced.bettor is the AGENT, not msg.sender', getAddress(bp.args.bettor) === AG, bp.args.bettor)
  chk('BetPlaced.stake == stake (fee excluded)', bp.args.stake === STK, f(bp.args.stake))
  chk('BetPlaced.fee == 2% of stake', bp.args.fee === FEE, f(bp.args.fee))
  const d = async (addr) => (await at(USDC, erc20, 'balanceOf', [addr], B)) - (await at(USDC, erc20, 'balanceOf', [addr], A))
  chk('agent paid exactly stake + fee', (await d(AG)) === -(STK + FEE), f(await d(AG)))
  chk('relay USDC unchanged across the bet', (await d(RL)) === 0n, f(await d(RL)))

  // --- settlement, and the two new events ---
  const logs = await pub.getLogs({ address: st.market, fromBlock: BigInt(st.betBlock), toBlock: 'latest' })
  const ev = parseEventLogs({ abi: M, logs })
  const ms = ev.find(l => l.eventName === 'MarketSettled')
  const sd = ev.find(l => l.eventName === 'SettlementDetails')
  chk('MarketSettled via UMA oracle', !!ms && ms.args.viaOracle === true,
      ms ? 'finalSpread=' + ms.args.finalSpread : 'none')
  chk('SettlementDetails present exactly once',
      ev.filter(l => l.eventName === 'SettlementDetails').length === 1)
  chk('SettlementDetails precedes MarketSettled', sd.logIndex < ms.logIndex, sd.logIndex + ' < ' + ms.logIndex)
  const SB = BigInt(st.settleBlock)
  const tP = await at(st.market, M, 'totalPool', [], SB)
  const sT = await at(st.market, M, 'protocolSeedTotal', [], SB)
  const cw = await at(st.market, M, 'cachedWinningStakes', [], SB)
  chk('SettlementDetails.distributable == totalPool - protocolSeedTotal', sd.args.distributable === tP - sT,
      f(sd.args.distributable) + ' vs ' + f(tP - sT))
  chk('SettlementDetails.winningStakes == cachedWinningStakes', sd.args.winningStakes === cw, f(cw))

  // --- the relayed claim ---
  const clRc = await pub.getTransactionReceipt({ hash: st.claimTx })
  const CB = clRc.blockNumber
  const cev = parseEventLogs({ abi: M, logs: clRc.logs })
  const pc = cev.find(l => l.eventName === 'PayoutClaimed')
  const bc = cev.find(l => l.eventName === 'BetClaimed')
  chk('claim tx succeeded', clRc.status === 'success', clRc.status)
  chk('claim msg.sender was the RELAY', getAddress(clRc.from) === RL, clRc.from)
  chk('claim tx.to == market', getAddress(clRc.to) === getAddress(st.market))
  chk('PayoutClaimed.bettor == AGENT', getAddress(pc.args.bettor) === AG)
  chk('BetClaimed.bettor == AGENT and betId matches',
      getAddress(bc.args.bettor) === AG && bc.args.betId === BigInt(st.betId))
  chk('BetClaimed.payout == PayoutClaimed.amount', bc.args.payout === pc.args.amount, f(pc.args.amount))
  const agentDelta = (await at(USDC, erc20, 'balanceOf', [AG], CB)) - (await at(USDC, erc20, 'balanceOf', [AG], CB - 1n))
  const relayDelta = (await at(USDC, erc20, 'balanceOf', [RL], CB)) - (await at(USDC, erc20, 'balanceOf', [RL], CB - 1n))
  chk('AGENT USDC increased by exactly the payout', agentDelta === pc.args.amount, f(agentDelta))
  chk('RELAY USDC delta == 0', relayDelta === 0n, f(relayDelta))
  chk('PayoutClaimed.amount == exactly 2x stake', pc.args.amount === STK * 2n, f(pc.args.amount))
  chk('market fully drained after the claim', (await at(USDC, erc20, 'balanceOf', [st.market], CB)) === 0n)
  chk('bet marked claimed', (await at(st.market, M, 'getBet', [BigInt(st.betId)], undefined)).claimed === true)

  // --- log-only reconstruction, again from chain ---
  const bpLog = ev.filter(l => l.eventName === 'BetPlaced').find(l => l.args.betId === BigInt(st.betId))
  const scaled = ms.args.finalSpread * 10000n
  const isWinner = bpLog.args.greaterThan ? scaled > bpLog.args.lockedZ : scaled <= bpLog.args.lockedZ
  const fromLogs = ms.args.refundMode ? bpLog.args.stake
                 : (isWinner ? (bpLog.args.stake * sd.args.distributable) / sd.args.winningStakes : 0n)
  chk('payout computed from EVENTS ALONE == USDC received', fromLogs === agentDelta, f(fromLogs))

  // --- the headline, re-read ---
  const eth = await readRetry(() => pub.getBalance({ address: AG }), 'agent ETH')
  const txc = await readRetry(() => pub.getTransactionCount({ address: AG }), 'agent nonce')
  chk('AGENT ETH balance is still exactly 0', eth === 0n, eth + ' wei')
  chk('AGENT transaction count is still exactly 0', txc === 0, String(txc))

  console.log('\n=== VERIFY SUMMARY === ' + pass + ' assertions / ' + fail + ' failures')
  if (fail) process.exit(1)
}

/** Compile only, assert the Gate 2b sizes, touch no network. Run this before funding. */
function sizes() {
  console.log('=== SIZES — compile only, no network access, no transactions ===')
  const arts = compile()
  assertSizes(arts)
  console.log('\n=== SIZES SUMMARY === ' + pass + ' assertions / ' + fail + ' failures')
  if (fail) process.exit(1)
}

const phase = process.argv[2]
if (phase === 'phase1') await phase1()
else if (phase === 'phase2') await phase2()
else if (phase === 'verify') await verify()
else if (phase === 'sizes') sizes()
else {
  console.log('usage: node sepolia-rehearsal-v3.mjs sizes | phase1 | phase2 | verify')
  console.log('  sizes   compile and check runtime sizes only — no network, no transactions')
  console.log('  phase1  deploy, relayed bet, requestSettlement')
  console.log('  phase2  executeSettlement, relayed claimPayoutFor, live negatives')
  console.log('  verify  re-read everything from chain, no transactions')
  process.exit(1)
}
