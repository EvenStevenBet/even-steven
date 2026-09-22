// W1–W5: placeBetForWithSignature — EOA bytes variant, ERC-1271 contract wallet,
// EIP-7702 delegated account, negatives, gas. v1.11 @ RUNS_B (default 200),
// compared where relevant against v1.10 @ runs=1 on the pinned Base mainnet fork.
import { compileSet, compileTestContract, V110, V111, assertSolc } from './lib/compile.mjs'
import { pub, test, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi,
         increaseTime, usdcDomain, derivedNonce, rawCall } from './lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from './lib/deploy.mjs'
import { settleOne } from './lib/flow.mjs'
import { ok, eq, section, summary } from './lib/report.mjs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex, encodeFunctionData, encodeAbiParameters, getAddress, decodeEventLog } from 'viem'

const RUNS_A = Number(process.env.RUNS_A || 1)
const RUNS_B = Number(process.env.RUNS_B || 200)
const USD = n => BigInt(Math.round(n * 1e6))
const SETTLE_SPREAD = 20n
const SEL = s => keccak256(toHex(s)).slice(0, 10)

const SIG_NEW = 'placeBetForWithSignature(address,bool,uint256,(uint256,uint256,bytes32,bytes32,bytes))'
const SEL_NEW = SEL(SIG_NEW)
const E = {
  BadAuthorizationNonce: SEL('BadAuthorizationNonce()'), InvalidBettor: SEL('InvalidBettor()'),
  MarketPaused: SEL('MarketPaused()'), BettingIsClosed: SEL('BettingIsClosed()'),
  BelowMinBet: SEL('BelowMinBet()'), MarketFull: SEL('MarketFull()'), NoPayout: SEL('NoPayout()'),
}
const TOPIC = {
  BetPlaced: keccak256(toHex('BetPlaced(address,uint256,uint256,uint256,bool,int256)')),
  PayoutClaimed: keccak256(toHex('PayoutClaimed(address,uint256)')),
}
const RWA_TYPES = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }

/** Raw 65-byte EIP-3009 signature over an authorization whose `from` may be a contract. */
async function signRaw({ signerAccount, from, market, value, validAfter = 0n, validBefore, nonce }) {
  const { domain } = await usdcDomain()
  const vb = validBefore ?? (await pub.getBlock()).timestamp + 3600n
  const signature = await signerAccount.signTypedData({
    domain, types: RWA_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from, to: market, value, validAfter, validBefore: vb, nonce } })
  return { signature, validAfter, validBefore: vb, nonce }
}
const authBytes = (r, salt, signature) => ({ validAfter: r.validAfter, validBefore: r.validBefore,
                                             nonce: r.nonce, salt, signature })
/** The Coinbase-Smart-Wallet-shaped envelope: abi.encode(ownerIndex, ecdsaSig). */
const wrap = (ownerIndex, sig) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [ownerIndex, sig])

const bal = a => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const decode = (abi, log) => decodeEventLog({ abi, data: log.data, topics: log.topics })
const logsOf = (r, addr, t0) => r.logs.filter(l => l.address.toLowerCase() === addr.toLowerCase() && l.topics[0] === t0)

console.log('='.repeat(78))
console.log('W1–W5 — placeBetForWithSignature on the pinned Base mainnet fork')
console.log('='.repeat(78))
console.log('solc        :', assertSolc())
console.log('optimizer   : runs=%d (v1.10) / runs=%d (v1.11), shanghai', RUNS_A, RUNS_B)
console.log('fork block  :', (await pub.getBlockNumber()).toString())
console.log('new selector:', SEL_NEW, SIG_NEW)

await assertFreshActors(6)
const [OWNER, RELAY, OPP, WOWNER, EOA, DAVE] = [0, 1, 2, 3, 4, 5].map(acct)
for (const a of [OWNER, RELAY, OPP, DAVE]) { await setBalanceEth(a.address, 10n ** 23n); await mintUSDC(a.address, USD(500000)) }
// WOWNER (the smart wallet's key) and EOA deliberately get NO ETH.
await mintUSDC(EOA.address, USD(10000))
await mintUSDC(WOWNER.address, USD(10))

const artsA = compileSet(V110, RUNS_A), artsB = compileSet(V111, RUNS_B)
const setA = await deployVersionSet(artsA, OWNER)
const setB = await deployVersionSet(artsB, OWNER)
const MA = artsA.SportsbookMarket.abi, M = artsB.SportsbookMarket.abi
await approveMax(OWNER, setA.factory); await approveMax(OWNER, setB.factory)
console.log('v1.10 sizes :', JSON.stringify(setA.sizes), ' market', artsA.SportsbookMarket.runtimeSize)
console.log('v1.11 sizes :', JSON.stringify(setB.sizes), ' market', artsB.SportsbookMarket.runtimeSize)

let seq = 0
const mk = async (set, seed = USD(1)) => (await createMarket(set, OWNER, `NFL-2026-05-01-HOME-W-AWAY-T-${seq++}`, 0n, seed)).market
async function betPlain(market, abi, account, side, stake) {
  await approveMax(account, market)
  const h = await wallet(account).writeContract({ address: market, abi, functionName: 'placeBet', args: [side, stake] })
  return pub.waitForTransactionReceipt({ hash: h })
}
async function send(market, abi, account, fn, args) {
  const h = await wallet(account).writeContract({ address: market, abi, functionName: fn, args })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  r._tx = await pub.getTransaction({ hash: h })
  return r
}
async function callSel(market, abi, from, fn, args) {
  const r = await rawCall({ from, to: market, data: encodeFunctionData({ abi, functionName: fn, args }) })
  return r.ok ? null : r
}
const STAKE = USD(100), FEE = STAKE * 200n / 10000n, COST = STAKE + FEE
const gas = []

/**
 * Run a block and turn any unexpected revert into a NAMED failure instead of a
 * crash. Mutation testing depends on this: a mutant that breaks a happy path must
 * show up as a red test, and the remaining sections must still run.
 */
async function sectionSafe(name, body) {
  section(name)
  try { await body() }
  catch (e) {
    ok(name.split('  ')[0] + ' section completed without an unexpected revert', false,
       (e.shortMessage || e.message || String(e)).split('\n').slice(0, 2).join(' | ').slice(0, 200))
  }
}

// ── W0 : the (v) difference itself ───────────────────────────────────────
await sectionSafe('W0  category (v): placeBetForWithSignature exists only in v1.11', async () => {
  const mA = await mk(setA), mB = await mk(setB)
  const dummy = { validAfter: 0n, validBefore: 2n ** 48n, nonce: keccak256(toHex('d')),
                  salt: keccak256(toHex('d')), signature: '0x' }
  const data = encodeFunctionData({ abi: M, functionName: 'placeBetForWithSignature',
                                    args: [EOA.address, true, STAKE, dummy] })
  const onA = await rawCall({ from: RELAY.address, to: mA, data })
  const onB = await rawCall({ from: RELAY.address, to: mB, data })
  console.log('  v1.10 raw result:', onA.ok ? onA.data : onA.data, '(' + (onA.ok ? 'no revert' : 'revert') + ')')
  console.log('  v1.11 raw result:', onB.ok ? onB.data : onB.data, '(' + (onB.ok ? 'no revert' : 'revert') + ')')
  ok('W0 selector reverts with NO data on v1.10 (no such function)', !onA.ok && (onA.data === null || onA.data === '0x'),
     String(onA.data))
  ok('W0 selector reaches the function on v1.11 (revert carries data)', !onB.ok && onB.data && onB.data !== '0x',
     String(onB.data).slice(0, 10))
  ok('W0 recorded as allowed difference (v)', true, 'placeBetForWithSignature exists only in v1.11')
})

// ── W1 : EOA through the bytes variant ───────────────────────────────────
await sectionSafe('W1  EOA via the bytes variant (signature = r||s||v) == placeBetFor on a twin market', async () => {
  const m1 = await mk(setB), m2 = await mk(setB)
  const salt = keccak256(toHex('w1'))
  const nonce = derivedNonce(salt, true)
  const s1 = await signRaw({ signerAccount: EOA, from: EOA.address, market: m1, value: COST, nonce })
  // A different market means a different EIP-712 message, so the twin needs its own
  // salt: an EIP-3009 nonce is burnt per signer, not per market.
  const salt2 = keccak256(toHex('w1-twin'))
  const nonce2 = derivedNonce(salt2, true)
  const s2 = await signRaw({ signerAccount: EOA, from: EOA.address, market: m2, value: COST, nonce: nonce2 })
  const vrs = { validAfter: s2.validAfter, validBefore: s2.validBefore, nonce: s2.nonce, salt: salt2,
                v: Number('0x' + s2.signature.slice(130, 132)), r: '0x' + s2.signature.slice(2, 66),
                s: '0x' + s2.signature.slice(66, 130) }

  await pub.request({ method: 'evm_setAutomine', params: [false] })
  const wr = wallet(RELAY)
  const h1 = await wr.writeContract({ address: m1, abi: M, functionName: 'placeBetForWithSignature',
    args: [EOA.address, true, STAKE, authBytes(s1, salt, s1.signature)], gas: 3000000n })
  const h2 = await wr.writeContract({ address: m2, abi: M, functionName: 'placeBetFor',
    args: [EOA.address, true, STAKE, vrs], gas: 3000000n })
  await pub.request({ method: 'evm_mine', params: [] })
  await pub.request({ method: 'evm_setAutomine', params: [true] })
  const r1 = await pub.getTransactionReceipt({ hash: h1 }), r2 = await pub.getTransactionReceipt({ hash: h2 })
  eq('W1 both entry points succeeded', [r1.status, r2.status], ['success', 'success'])

  // Tokenise the market AND the EIP-3009 nonce. The twin must use a different salt
  // (a nonce is burnt per signer, not per market), so USDC's AuthorizationUsed log
  // legitimately differs; everything else must match byte for byte.
  const norm = (r, m, non) => JSON.stringify(r.logs.map(l => {
    const sub = x => x.replaceAll(m.slice(2).toLowerCase(), '<MARKET>')
                      .replaceAll(non.slice(2).toLowerCase(), '<AUTH_NONCE>')
    return { a: l.address.toLowerCase() === m.toLowerCase() ? 'MARKET' : l.address.toLowerCase(),
             t: l.topics.map(sub), d: sub(l.data) }
  }))
  eq('W1 logs identical (bytes variant vs placeBetFor)', norm(r1, m1, nonce), norm(r2, m2, nonce2))
  const bp1 = decode(M, logsOf(r1, m1, TOPIC.BetPlaced)[0])
  eq('W1 BetPlaced.bettor == the signing EOA, not the relay', bp1.args.bettor, EOA.address)
  eq('W1 tx.from was the RELAY', (await pub.getTransaction({ hash: h1 })).from.toLowerCase(), RELAY.address.toLowerCase())
  for (const [m, label] of [[m1, 'bytes variant'], [m2, 'placeBetFor']]) {
    const b = await pub.readContract({ address: m, abi: M, functionName: 'getBet', args: [0n] })
    eq(`W1 ${label}: stored bettor/stake/side`, [b.bettor, b.stake, b.greaterThan], [EOA.address, STAKE, true])
    eq(`W1 ${label}: market holds seed + stake`, await bal(m), USD(2) + STAKE)
  }
  gas.push({ case: 'placeBetForWithSignature (EOA, 65-byte sig)', gas: r1.gasUsed },
           { case: 'placeBetFor (EOA, v/r/s)', gas: r2.gasUsed })
})

// ── W2 : ERC-1271 contract wallet ────────────────────────────────────────
await sectionSafe('W2  ERC-1271 smart wallet with a NON-65-byte signature envelope', async () => {
  const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
  const wh = await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, 0] })
  const W = (await pub.waitForTransactionReceipt({ hash: wh })).contractAddress
  await mintUSDC(W, COST)
  eq('W2 wallet funded with USDC only', await bal(W), COST)
  eq('W2 wallet has code (is a contract)', ((await pub.getCode({ address: W })).length - 2) / 2 > 0, true)
  eq('W2 wallet ETH balance == 0', await pub.getBalance({ address: W }), 0n)
  eq('W2 wallet OWNER key ETH == 0', await pub.getBalance({ address: WOWNER.address }), 0n)
  eq('W2 wallet OWNER key tx count == 0', await pub.getTransactionCount({ address: WOWNER.address }), 0)

  const m = await mk(setB)
  const salt = keccak256(toHex('w2'))
  const nonce = derivedNonce(salt, true)
  // The wallet is the `from`; its OWNER key signs; the envelope is abi.encode(0, sig).
  const raw = await signRaw({ signerAccount: WOWNER, from: W, market: m, value: COST, nonce })
  const envelope = wrap(0n, raw.signature)
  console.log('  raw ECDSA sig length   :', (raw.signature.length - 2) / 2, 'bytes')
  console.log('  ERC-1271 envelope len  :', (envelope.length - 2) / 2, 'bytes  (not expressible as v,r,s)')

  // The same authorization CANNOT go through placeBetFor: v,r,s carries 65 bytes only.
  const trunc = { validAfter: raw.validAfter, validBefore: raw.validBefore, nonce, salt,
                  v: Number('0x' + envelope.slice(130, 132)), r: '0x' + envelope.slice(2, 66),
                  s: '0x' + envelope.slice(66, 130) }
  const viaOld = await callSel(m, M, RELAY.address, 'placeBetFor', [W, true, STAKE, trunc])
  ok('W2 the envelope truncated into v/r/s is rejected by placeBetFor', !!viaOld,
     viaOld ? String(viaOld.data).slice(0, 10) + ' ' + (viaOld.message || '').slice(0, 60) : 'call succeeded')

  const r = await send(m, M, RELAY, 'placeBetForWithSignature', [W, true, STAKE, authBytes(raw, salt, envelope)])
  eq('W2 placeBetForWithSignature succeeded', r.status, 'success')
  const bp = decode(M, logsOf(r, m, TOPIC.BetPlaced)[0])
  eq('W2 BetPlaced.bettor == the WALLET contract', bp.args.bettor, getAddress(W))
  eq('W2 tx.from was the RELAY', r._tx.from.toLowerCase(), RELAY.address.toLowerCase())
  eq('W2 wallet USDC spent exactly stake + fee', await bal(W), 0n)
  gas.push({ case: 'placeBetForWithSignature (ERC-1271 wallet)', gas: r.gasUsed })

  await betPlain(m, M, OPP, false, STAKE)
  await settleOne(m, M, OWNER, SETTLE_SPREAD)
  const before = await bal(W)
  const cr = await send(m, M, RELAY, 'claimPayoutFor', [W, [0n]])
  const pc = decode(M, logsOf(cr, m, TOPIC.PayoutClaimed)[0])
  eq('W2 claimPayoutFor paid the WALLET exactly 2x stake', await bal(W) - before, STAKE * 2n)
  eq('W2 PayoutClaimed.bettor == wallet', pc.args.bettor, getAddress(W))
  eq('W2 claim submitted by the RELAY', cr._tx.from.toLowerCase(), RELAY.address.toLowerCase())
  eq('W2 market drained', await bal(m), 0n)
  eq('W2 wallet OWNER key still 0 ETH / 0 txs',
     [await pub.getBalance({ address: WOWNER.address }), await pub.getTransactionCount({ address: WOWNER.address })], [0n, 0])
  gas.push({ case: 'claimPayoutFor (ERC-1271 wallet)', gas: cr.gasUsed })
})

// ── W3 : EIP-7702 ────────────────────────────────────────────────────────
await sectionSafe('W3  EIP-7702 delegated account', async () => {
  // EIP-7702 is a PRAGUE feature. This suite's node runs `hardfork: shanghai`
  // (matching the contracts' evmVersion), where 0xef0100||delegate is not a
  // delegation indicator at all — it is just 23 bytes of invalid code. Testing 7702
  // here would measure "account has non-executable code", not delegation, and would
  // reach the right answer for the wrong reason.
  //
  // W3 therefore runs on a separate Prague-capable node: scripts/fork-tests/prague/.
  // hardhat 2.22.17's EDR tops out at cancun, so that harness pins its own newer
  // hardhat. See prague/README.md.
  const probe = privateKeyToAccount(generatePrivateKey())
  await test.setCode({ address: probe.address, bytecode: '0xef0100' + '11'.repeat(20) })
  const code = await pub.getCode({ address: probe.address })
  const delegateResolves = await (async () => {
    // Under Prague a call into a delegated account runs the delegate's code. Under
    // Shanghai the 0xef byte is an invalid opcode, so any call reverts.
    const r = await rawCall({ from: RELAY.address, to: probe.address, data: '0x1626ba7e' })
    return r.ok
  })()
  ok('W3 node reports the delegation bytes as account code', code === '0xef0100' + '11'.repeat(20), code)
  ok('W3 SKIPPED HERE — this node is pre-Prague, so 7702 has no semantics', !delegateResolves,
     'run scripts/fork-tests/prague/w3.mjs for the real result')
})

// ── W4 : negatives ───────────────────────────────────────────────────────
await sectionSafe('W4  negatives', async () => {
  const m = await mk(setB)
  const mk2 = async (saltStr, side = true, from = EOA.address, signer = EOA, market = m, value = COST) => {
    const salt = keccak256(toHex(saltStr)), nonce = derivedNonce(salt, side)
    const raw = await signRaw({ signerAccount: signer, from, market, value, nonce })
    return { salt, raw, auth: authBytes(raw, salt, raw.signature) }
  }
  const expectSel = async (label, args, want, fn = 'placeBetForWithSignature') => {
    const r = await callSel(m, M, RELAY.address, fn, args)
    const got = r ? String(r.data).slice(0, 10) : 'NO REVERT'
    eq(label, got, want)
  }
  const good = await mk2('w4-good')
  const rnd = keccak256(toHex('x402-random'))
  await expectSel('W4 random x402 nonce -> BadAuthorizationNonce',
    [EOA.address, true, STAKE, { ...good.auth, nonce: rnd }], E.BadAuthorizationNonce)
  await expectSel('W4 side flip (signed GREATER, submitted LESS) -> BadAuthorizationNonce',
    [EOA.address, false, STAKE, good.auth], E.BadAuthorizationNonce)
  await expectSel('W4 bettor = address(0) -> InvalidBettor',
    ['0x0000000000000000000000000000000000000000', true, STAKE, good.auth], E.InvalidBettor)
  await expectSel('W4 below minimum stake -> BelowMinBet',
    [EOA.address, true, 1n, (await mk2('w4-min')).auth], E.BelowMinBet)

  const raws = async (label, auth, bettor = EOA.address) => {
    const r = await callSel(m, M, RELAY.address, 'placeBetForWithSignature', [bettor, true, STAKE, auth])
    const d = r ? r.data : null
    let dec = ''
    if (d && String(d).startsWith('0x08c379a0')) {
      const h = String(d); const len = parseInt(h.slice(2 + 8 + 64, 2 + 8 + 128), 16)
      dec = ' Error("' + Buffer.from(h.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString('utf8') + '")'
    }
    ok(label, !!r, (d === null ? 'no data' : String(d).slice(0, 10)) + dec)
    return d
  }
  await raws('W4 empty signature -> raw revert', { ...(await mk2('w4-empty')).auth, signature: '0x' })
  await raws('W4 truncated signature -> raw revert', { ...(await mk2('w4-trunc')).auth, signature: (await mk2('w4-trunc')).raw.signature.slice(0, 100) })
  await raws('W4 expired authorization -> raw revert',
    (await (async () => { const s = keccak256(toHex('w4-exp')); const n = derivedNonce(s, true)
      const now = (await pub.getBlock()).timestamp
      const r = await signRaw({ signerAccount: EOA, from: EOA.address, market: m, value: COST, nonce: n, validBefore: now - 10n })
      return authBytes(r, s, r.signature) })()))
  await raws('W4 not-yet-valid authorization -> raw revert',
    (await (async () => { const s = keccak256(toHex('w4-fut')); const n = derivedNonce(s, true)
      const now = (await pub.getBlock()).timestamp
      const r = await signRaw({ signerAccount: EOA, from: EOA.address, market: m, value: COST, nonce: n, validAfter: now + 100000n })
      return authBytes(r, s, r.signature) })()))

  // wrong magic / reverting wallet
  const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
  for (const [mode, label] of [[1, 'returns the wrong magic value'], [2, 'reverts inside isValidSignature']]) {
    const wh = await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, mode] })
    const W = (await pub.waitForTransactionReceipt({ hash: wh })).contractAddress
    await mintUSDC(W, COST)
    const s = keccak256(toHex('w4-w' + mode)), n = derivedNonce(s, true)
    const raw = await signRaw({ signerAccount: WOWNER, from: W, market: m, value: COST, nonce: n })
    await raws('W4 wallet that ' + label + ' -> raw revert', authBytes(raw, s, wrap(0n, raw.signature)), W)
  }

  // replay: place one for real, then re-submit
  {
    const g = await mk2('w4-replay')
    const r = await send(m, M, RELAY, 'placeBetForWithSignature', [EOA.address, true, STAKE, g.auth])
    eq('W4 (setup) first submission succeeds', r.status, 'success')
    await raws('W4 replay of a used authorization -> raw revert', g.auth)
  }
  // paused
  await send(m, M, OWNER, 'pause', [])
  await expectSel('W4 paused -> MarketPaused', [EOA.address, true, STAKE, (await mk2('w4-paused')).auth], E.MarketPaused)
  await send(m, M, OWNER, 'unpause', [])
  // betting closed
  await send(m, M, OWNER, 'closeBetting', [])
  await expectSel('W4 betting closed -> BettingIsClosed', [EOA.address, true, STAKE, (await mk2('w4-closed')).auth], E.BettingIsClosed)
})
// MAX_BETS boundary through the new function
{
  const m = await mk(setB)
  const filler = compileTestContract('BetFiller.sol', 'BetFiller')
  const w = wallet(OWNER)
  const fh = await w.deployContract({ abi: filler.abi, bytecode: filler.bytecode, args: [] })
  const fAddr = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress
  await mintUSDC(fAddr, USD(1000000))
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: fAddr, abi: filler.abi,
    functionName: 'approveMarket', args: [USDC, m], gas: 200000n }) })
  for (let done = 0; done < 1000; done += 100) {
    const h = await w.writeContract({ address: fAddr, abi: filler.abi, functionName: 'fill',
      args: [m, 100n, USD(1), BigInt(done)], gas: 190000000n })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') throw new Error('fill reverted at ' + done)
  }
  const st = await pub.readContract({ address: m, abi: M, functionName: 'getMarketStatus' })
  eq('W4 market is full (betsRemaining == 0)', st[4], 0n)
  const salt = keccak256(toHex('w4-full')), nonce = derivedNonce(salt, true)
  const raw = await signRaw({ signerAccount: EOA, from: EOA.address, market: m, value: COST, nonce })
  const r = await callSel(m, M, RELAY.address, 'placeBetForWithSignature', [EOA.address, true, STAKE, authBytes(raw, salt, raw.signature)])
  eq('W4 MAX_BETS boundary -> MarketFull', r ? String(r.data).slice(0, 10) : 'NO REVERT', E.MarketFull)
}

section('W5  GAS')
console.log('  case'.padEnd(48), 'gas')
for (const g of gas) console.log('  ' + g.case.padEnd(46), String(g.gas))

const s = summary()
process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
