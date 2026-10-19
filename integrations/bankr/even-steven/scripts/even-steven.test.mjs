// Unit tests: mocked Bankr API, relay and RPC; throwaway key; no network, no real key.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { encodeAbiParameters, getAddress, hashTypedData } from 'viem'
import { createCli, explainBetError, explainClaimError, parseStake, parseGameId, matchMarket, lineSentence, winThreshold,
         deriveNonce, CLAIM_SENTENCE, FACTORY, USDC, MAGIC_1271 } from './even-steven.mjs'

const KEY = 'bk_TEST_ONLY_skill_not_a_real_key_9876543210'
const wallet = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
const MK1 = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26'   // Dolphins/Chiefs
const MK2 = '0x7aEb7eb0812e9150b13Ce45CE08b82d4406c8F5E'   // Packers/Cowboys
const MK3 = '0x3333333333333333333333333333333333333333'   // second Cowboys game
const FOREIGN = '0x4444444444444444444444444444444444444444'
const SALT = '0x' + '5a'.repeat(32)
let T = 1_800_000_000

function world(over = {}) {
  const w = {
    fee: 200n,
    markets: {
      [MK1.toLowerCase()]: { gameId: 'NFL-2026-10-18-HOME-Dolphins-AWAY-Chiefs', z: 0n, g: 11_000_000n, le: 11_000_000n, open: true, settled: false },
      [MK2.toLowerCase()]: { gameId: 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys', z: -35000n, g: 30_000_000n, le: 10_000_000n, open: true, settled: false },
      [MK3.toLowerCase()]: { gameId: 'NFL-2026-10-25-HOME-Cowboys-AWAY-Giants', z: 20000n, g: 3_000_000n, le: 3_000_000n, open: true, settled: false },
    },
    open: [MK1, MK2, MK3], all: [MK1, MK2, MK3],
    bets: {},          // market lower -> [{bettor, stake, greaterThan, lockedZ, claimed}]
    code: '0x',
    ...over,
  }
  return w
}
function chain(w) {
  return {
    getCode: async () => w.code,
    readContract: async ({ address, functionName, args }) => {
      const mk = w.markets[String(address).toLowerCase()]
      switch (functionName) {
        case 'getOpenMarkets': return w.open
        case 'getAllMarkets': return w.all
        case 'gameIdByMarket': return w.markets[String(args[0]).toLowerCase()]?.gameId ?? ''
        case 'getMarketState': return [mk.gameId, mk.z, mk.g, mk.le, mk.g + mk.le, mk.open, mk.settled]
        case 'FEE_PERCENT': return w.fee
        case 'getMarketEV': return [args[0] * 3n / 2n, args[0] * 2n, w.fee]
        case 'getBetsByAddress': return (w.bets[String(address).toLowerCase()] || []).map((_, i) => BigInt(i))
        case 'getBet': return w.bets[String(address).toLowerCase()][Number(args[0])]
        case 'isValidSignature': return w.erc1271 ?? MAGIC_1271
        default: throw new Error('unmocked ' + functionName)
      }
    },
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'es-skill-'))
function setup(over = {}, envOver = {}, relay = {}) {
  const w = world(over.world)
  const dir = tmp()
  const cfg = path.join(dir, 'config.json'); fs.writeFileSync(cfg, JSON.stringify({ apiKey: KEY }))
  const calls = []
  const state = { signFn: null, signStatus: 200, signBody: null, relayQueue: [], claimQueue: [], meSigner: wallet.address, ...over }
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ host: u.host, path: u.pathname, method, body, key: init.headers?.['X-API-Key'] })
    const reply = (status, b) => ({ status, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) })
    if (u.host === 'api.bankr.bot' && u.pathname === '/wallet/me') return reply(200, { success: true, wallets: [{ chain: 'solana', address: 'S1' }, { chain: 'evm', address: wallet.address }] })
    if (u.host === 'api.bankr.bot' && u.pathname === '/wallet/sign') {
      if (state.signStatus !== 200) return reply(state.signStatus, state.signBody)
      const td = body.typedData
      const sig = state.signFn ? await state.signFn(td) : await signTd(wallet, td)
      return reply(200, { success: true, signature: sig, signer: state.meSigner, signatureType: 'eth_signTypedData_v4' })
    }
    if (u.host === 'evensteven.bet' && u.pathname === '/api/bet') { const r = state.relayQueue.shift() ?? { status: 200, body: okBet() }; return reply(r.status, r.body) }
    if (u.host === 'evensteven.bet' && u.pathname === '/api/claim') { const r = state.claimQueue.shift() ?? { status: 200, body: { claimed: [], note: 'Nothing claimable', txHashes: [], claimedCount: 0, remainingCount: 0 } }; return reply(r.status, r.body) }
    throw new Error('unexpected call ' + url)
  }
  let n = 0
  const cli = createCli({ env: { BANKR_CONFIG: cfg, ES_STATE_DIR: path.join(dir, 'state'), ...envOver }, now: () => T, fetchImpl, publicClient: chain(w),
    randomSalt: () => SALT, randomId: () => (n++).toString(16).padStart(8, '0'), log: () => {} })
  return { cli, w, calls, state, dir }
}
const okBet = (o = {}) => ({ success: true, betId: '3', bettor: wallet.address, relay: '0x8a3e', marketAddress: MK2, gameId: 'x', greaterThan: false, stake: '10000000', fee: '200000', lockedZ: '-35000', lockedZDisplay: '-3.5', txHash: '0x' + 'ab'.repeat(32), blockNumber: '1', ...o })
const signTd = (acct, td) => acct.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } })
const txt = (cli) => cli.lines.join('\n')
const noKey = (cli) => assert.ok(!txt(cli).includes(KEY), 'API key leaked into output')
const signCalls = (calls) => calls.filter((c) => c.path === '/wallet/sign')
const betCalls = (calls) => calls.filter((c) => c.path === '/api/bet')
async function prepared(s, args = ['bet', '--prepare', 'Packers Cowboys', 'away', '10']) {
  const code = await s.cli.run(args); assert.equal(code, 0, txt(s.cli)); return '00000000'
}

// ---- pure helpers ----
test('stake parsing: min 1, default max 25, ES_MAX_STAKE override, decimals', () => {
  assert.equal(parseStake('1'), 1_000_000n)
  assert.equal(parseStake('12.5'), 12_500_000n)
  assert.equal(parseStake('25'), 25_000_000n)
  assert.throws(() => parseStake('0.99'), /minimum stake is 1 USDC/)
  assert.throws(() => parseStake('25.01'), /maximum stake of 25.00/)
  assert.equal(parseStake('100', '100'), 100_000_000n)
  assert.throws(() => parseStake('101', '100'), /maximum/)
  for (const bad of ['abc', '-5', '1e3', '1.1234567', '']) assert.throws(() => parseStake(bad), /not a USDC amount/)
})
test('game id, matching, and line sentences', () => {
  assert.deepEqual(parseGameId('MLB-2026-07-04-HOME-Yankees-AWAY-RedSox-G2'), { sport: 'MLB', date: '2026-07-04', home: 'Yankees', away: 'RedSox' })
  assert.equal(winThreshold(-35000n), -3)
  assert.equal(lineSentence(-35000n, 'away', 'Packers', 'Cowboys'), 'Cowboys -3.5: you win if the Cowboys win by 4 or more')
  assert.equal(lineSentence(-35000n, 'home', 'Packers', 'Cowboys'), 'Packers +3.5: you win if the Packers win, tie, or lose by up to 3')
  assert.equal(deriveNonce(SALT, true) === deriveNonce(SALT, false), false)
})

// ---- read-only commands ----
test('markets: lists open markets with a readable line, pools, and open state; key never printed', async () => {
  const s = setup(); assert.equal(await s.cli.run(['markets']), 0)
  const o = txt(s.cli)
  assert.match(o, /Packers \(home\) vs Cowboys \(away\)/)
  assert.match(o, /Cowboys favored by 3\.5/)          // z = -3.5 -> away (Cowboys) quoted -3.5
  assert.match(o, /Pools: home 30\.00 USDC, away 10\.00 USDC, total 40\.00 USDC/)
  assert.match(o, /Betting open/)
  assert.equal(s.calls.length, 0, 'markets uses chain reads only')
  noKey(s.cli)
})
test('markets --all and odds --all include closed markets', async () => {
  const s = setup({ world: { open: [MK1] } }); assert.equal(await s.cli.run(['markets', '--all']), 0); assert.match(txt(s.cli), /Recent markets \(3/)
  assert.equal(await s.cli.run(['odds', 'giants', '--all']), 0); assert.match(txt(s.cli), /Cowboys \(home\) vs Giants/)
  assert.equal(await s.cli.run(['odds', 'giants']), 3)
})
test('odds: chain reads only, never calls the paid quote endpoint, quotes gross and never promises', async () => {
  const s = setup(); assert.equal(await s.cli.run(['odds', 'packers', '--stake', '10']), 0)
  assert.equal(s.calls.length, 0)
  const o = txt(s.cli)
  assert.match(o, /gross/); assert.match(o, /set at settlement from the final pool/)
  assert.doesNotMatch(o, /profit|guarantee|\$100/i)
})
test('odds: ambiguous words ask, never guess', async () => {
  const s = setup(); assert.equal(await s.cli.run(['odds', 'cowboys']), 3)
  assert.match(txt(s.cli), /Ask the user which one/); assert.match(txt(s.cli), /Packers-AWAY-Cowboys/); assert.match(txt(s.cli), /Cowboys-AWAY-Giants/)
})

// ---- two-phase gating ----
test('prepare: writes a pending intent and prints the confirmation in value order, ending "Reply confirm."', async () => {
  const s = setup(); const id = await prepared(s)
  const o = txt(s.cli)
  const i1 = o.indexOf('1. Even money'), i2 = o.indexOf('2. The early line'), i3 = o.indexOf('3. Cost')
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2, 'value order')
  assert.match(o, /this line locks when your bet lands/)
  assert.match(o, /flat 2% fee on your stake, paid upfront. Stake 10\.00 USDC \+ fee 0\.20 USDC = total 10\.20 USDC/)
  assert.ok(o.trim().endsWith('Reply confirm.'))
  assert.doesNotMatch(o, /profit|guarantee|\$100|builder|points|affiliate/i)
  const intent = JSON.parse(fs.readFileSync(path.join(s.dir, 'state', 'intents', id + '.json'), 'utf8'))
  assert.equal(intent.state, 'pending'); assert.equal(intent.expiresAt - intent.createdAt, 300)
  assert.equal(intent.total, '10200000'); assert.equal(intent.greaterThan, false)
  assert.equal(signCalls(s.calls).length, 0, 'prepare never signs'); noKey(s.cli)
})
test('prepare: fee is read from the market (FEE_PERCENT), not assumed', async () => {
  const s = setup({ world: { fee: 300n } }); await prepared(s)
  assert.match(txt(s.cli), /flat 3% fee.*fee 0\.30 USDC = total 10\.30 USDC/)
})
test('prepare: ambiguous game and ambiguous side ask the user and write no intent', async () => {
  let s = setup(); assert.equal(await s.cli.run(['bet', '--prepare', 'cowboys', 'home', '5']), 3)
  assert.match(txt(s.cli), /Ask the user which one/)
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'intents')))
  s = setup(); assert.equal(await s.cli.run(['bet', '--prepare', 'Packers Cowboys', 'cheesehead', '5']), 3)
  assert.match(txt(s.cli), /Which side\?/)
  s = setup(); assert.equal(await s.cli.run(['bet', '--prepare', 'nonexistent team', 'home', '5']), 3)
})
test('prepare: a team name picks the side; a team name that is in both games is only ambiguous across games', async () => {
  const s = setup(); await prepared(s, ['bet', '--prepare', 'Packers Cowboys', 'Cowboys', '5'])
  assert.match(txt(s.cli), /Your pick: Cowboys/)
})
test('prepare: stake limits and closed market', async () => {
  let s = setup(); assert.equal(await s.cli.run(['bet', '--prepare', 'Packers', 'home', '0.5']), 1); assert.match(txt(s.cli), /minimum stake is 1 USDC/)
  s = setup(); assert.equal(await s.cli.run(['bet', '--prepare', 'Packers', 'home', '26']), 1); assert.match(txt(s.cli), /maximum stake of 25\.00/)
  s = setup({}, { ES_MAX_STAKE: '50' }); assert.equal(await s.cli.run(['bet', '--prepare', 'Packers', 'home', '40']), 0)
  s = setup({ world: { markets: { ...world().markets, [MK2.toLowerCase()]: { ...world().markets[MK2.toLowerCase()], open: false } } } })
  assert.equal(await s.cli.run(['bet', '--prepare', 'Packers', 'home', '5']), 1); assert.match(txt(s.cli), /closed/)
})
test('bet without a phase, and confirm without a prior prepare, are refused and never sign', async () => {
  const s = setup()
  assert.equal(await s.cli.run(['bet', 'Packers', 'home', '5']), 1); assert.match(txt(s.cli), /two steps/)
  assert.equal(await s.cli.run(['bet', '--confirm', 'deadbeef']), 1); assert.match(txt(s.cli), /No prepared bet/)
  assert.equal(await s.cli.run(['bet', '--confirm', '../../etc']), 1); assert.match(txt(s.cli), /not a valid intent id/)
  assert.equal(signCalls(s.calls).length, 0); assert.equal(betCalls(s.calls).length, 0)
})
test('intent expiry: a prepared bet older than 5 minutes is refused, nothing is signed', async () => {
  T = 1_800_000_000; const s = setup(); const id = await prepared(s)
  T += 301
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /expired/)
  assert.equal(signCalls(s.calls).length, 0)
  T = 1_800_000_000
})

// ---- happy path ----
test('confirm: signs through Bankr with decimal-string uints, posts the exact relay payload, prints the locked line and tx link', async () => {
  T = 1_800_000_000; const s = setup(); const id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 0, txt(s.cli))
  const [sc] = signCalls(s.calls)
  assert.equal(sc.body.signatureType, 'eth_signTypedData_v4')
  const td = sc.body.typedData
  assert.deepEqual(td.domain, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC })
  assert.equal(td.primaryType, 'ReceiveWithAuthorization')
  assert.deepEqual(Object.keys(td.types), ['ReceiveWithAuthorization'])
  assert.deepEqual(td.message, { from: wallet.address, to: MK2, value: '10200000', validAfter: '0', validBefore: String(T + 600), nonce: deriveNonce(SALT, false) })
  for (const k of ['value', 'validAfter', 'validBefore']) assert.equal(typeof td.message[k], 'string')
  const [bc] = betCalls(s.calls)
  assert.deepEqual(Object.keys(bc.body).sort(), ['bettor', 'greaterThan', 'marketAddress', 'nonce', 'salt', 'signature', 'stake', 'validAfter', 'validBefore'])
  assert.equal(bc.body.greaterThan, false); assert.equal(bc.body.stake, '10000000'); assert.equal(bc.body.salt, SALT)
  assert.ok(!('ref' in bc.body), 'no ref by default')
  assert.match(txt(s.cli), /Bet placed\. Cowboys -3\.5/); assert.match(txt(s.cli), /basescan\.org\/tx\/0xabab/)
  assert.equal(s.calls.every((c) => c.host !== 'api.bankr.bot' || c.path === '/wallet/me' || c.path === '/wallet/sign'), true, 'only /wallet/me and /wallet/sign on Bankr')
  noKey(s.cli)
  // already used
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /already placed/)
  assert.equal(signCalls(s.calls).length, 1)
})
test('ES_REF: optional, validated by the relay, included only when set', async () => {
  const s = setup({}, { ES_REF: 'my-channel' }); const id = await prepared(s)
  await s.cli.run(['bet', '--confirm', id]); assert.equal(betCalls(s.calls)[0].body.ref, 'my-channel')
})
test('lowercase signer from Bankr is accepted (compared with getAddress)', async () => {
  const s = setup({ meSigner: wallet.address.toLowerCase() }); const id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 0, txt(s.cli)); assert.equal(betCalls(s.calls).length, 1)
})

// ---- pre-sign checks: every one has a failing case ----
async function checks(mut, { stake = 10_000_000n, greaterThan = false, wal = wallet.address } = {}) {
  const s = setup(); const t = T
  const td = s.cli.buildAuthorization({ wallet: wallet.address, market: getAddress(MK2), stake, fee: stake * 200n / 10000n, greaterThan, salt: SALT, t })
  mut?.(td)
  return s.cli.preSignChecks({ td, wallet: wal, stake, greaterThan, salt: SALT, t })
}
const aborts = (p, re = /Aborted before signing/) => assert.rejects(p, re)
test('pre-sign: the unmodified authorization passes', async () => { await checks() })
test('pre-sign: wrong domain name / version / chainId / verifyingContract / extra field', async () => {
  await aborts(checks((t) => { t.domain.name = 'USDC' }))
  await aborts(checks((t) => { t.domain.version = '1' }))
  await aborts(checks((t) => { t.domain.chainId = 1 }))
  await aborts(checks((t) => { t.domain.verifyingContract = FOREIGN }))
  await aborts(checks((t) => { t.domain.salt = '0x00' }))
})
test('pre-sign: primaryType must be exactly ReceiveWithAuthorization (not Transfer, Permit, approval)', async () => {
  await aborts(checks((t) => { t.primaryType = 'TransferWithAuthorization' }))
  await aborts(checks((t) => { t.primaryType = 'Permit' }))
  await aborts(checks((t) => { t.types = { Permit: [] }; t.primaryType = 'Permit' }))
  await aborts(checks((t) => { t.types.Permit = [{ name: 'owner', type: 'address' }] }))
})
test('pre-sign: `to` must be a market the v1.6 factory created', async () => {
  await aborts(checks((t) => { t.message.to = FOREIGN }), /not a market created by Factory v1\.6/)
  await aborts(checks((t) => { t.message.to = USDC }), /not a market/)
  await aborts(checks((t) => { t.message.to = 'nope' }), /not a market/)
})
test('pre-sign: value must equal stake + stake*FEE_PERCENT/10000 using the market fee', async () => {
  await aborts(checks((t) => { t.message.value = '10000000' }), /value is not stake plus/)
  await aborts(checks((t) => { t.message.value = '10200001' }), /value is not stake plus/)
  await aborts(checks((t) => { t.message.value = '12000000' }), /value is not stake plus/)
})
test('pre-sign: `from` must be the Bankr wallet', async () => {
  await aborts(checks((t) => { t.message.from = other.address }), /not your Bankr wallet/)
})
test('pre-sign: validAfter 0, validBefore now+600, nonce derived from salt and side', async () => {
  await aborts(checks((t) => { t.message.validAfter = '1' }), /validAfter/)
  await aborts(checks((t) => { t.message.validBefore = String(T + 601) }), /validBefore/)
  await aborts(checks((t) => { t.message.validBefore = String(T + 60) }), /validBefore/)
  await aborts(checks((t) => { t.message.nonce = '0x' + '00'.repeat(32) }), /nonce/)
  await aborts(checks((t) => { t.message.nonce = deriveNonce(SALT, true) }), /nonce/)   // wrong side
})
test('pre-sign: uint256 values must be decimal strings; stake bounds enforced', async () => {
  await aborts(checks((t) => { t.message.value = 10200000 }), /decimal string/)
  await aborts(checks((t) => { t.message.validBefore = BigInt(T + 600) }), /decimal string/)
  await aborts(checks(null, { stake: 500_000n }), /under 1 USDC|value/)
  await aborts(checks(null, { stake: 26_000_000n }), /over the maximum|value/)
})
test('pre-sign failures in the live flow abort before /wallet/sign: tampered intent, fee change, closed market, wallet change', async () => {
  let s = setup(); let id = await prepared(s)
  const p = path.join(s.dir, 'state', 'intents', id + '.json'); const i = JSON.parse(fs.readFileSync(p, 'utf8'))
  i.market = FOREIGN; fs.writeFileSync(p, JSON.stringify(i))
  s.w.markets[FOREIGN.toLowerCase()] = { gameId: '', z: 0n, g: 0n, le: 0n, open: true, settled: false }
  await assert.rejects(s.cli.run(['bet', '--confirm', id]).then((c) => { if (c === 1) throw new Error('Aborted before signing'); return c }), /Aborted/)
  assert.equal(signCalls(s.calls).length, 0)

  s = setup(); id = await prepared(s); s.w.fee = 300n
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /fee changed/); assert.equal(signCalls(s.calls).length, 0)

  s = setup(); id = await prepared(s); s.w.markets[MK2.toLowerCase()].open = false
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /closed/); assert.equal(signCalls(s.calls).length, 0)
})

// ---- signer and signature verification ----
test('signer other than the wallet aborts, nothing is sent to the relay', async () => {
  const s = setup({ meSigner: other.address }); const id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /signer Bankr returned is not your wallet/)
  assert.equal(betCalls(s.calls).length, 0)
})
test('a signature that does not recover to the wallet aborts before the relay (protects against a relay strike)', async () => {
  const s = setup({ signFn: (td) => signTd(other, td) }); const id = await prepared(s)   // signer field says wallet, signature is by another key
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /does not verify/)
  assert.equal(betCalls(s.calls).length, 0)
})
test('non-65-byte signature: accepted only if the wallet has code and isValidSignature returns the magic value', async () => {
  const wrap = async (td) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, await signTd(wallet, td)])
  let s = setup({ signFn: wrap, world: { code: '0x6080604052' } }); let id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 0, txt(s.cli)); assert.equal(betCalls(s.calls).length, 1)
  s = setup({ signFn: wrap, world: { code: '0x6080604052', erc1271: '0xffffffff' } }); id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.equal(betCalls(s.calls).length, 0)
  s = setup({ signFn: wrap, world: { code: '0x' } }); id = await prepared(s)    // EOA cannot produce a wrapped signature
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.equal(betCalls(s.calls).length, 0)
})

// ---- 403 on /wallet/sign ----
test('403 from /wallet/sign: body verbatim, explains Trusted Addresses / key restriction, exit 2, nothing sent', async () => {
  const body = '{"error":"Restricted API key","message":"This API key has trusted recipient restrictions configured."}'
  const s = setup({ signStatus: 403, signBody: body }); const id = await prepared(s)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 2)
  assert.ok(s.cli.lines.includes(body)); assert.match(txt(s.cli), /Trusted Addresses/); assert.match(txt(s.cli), /restricts typed-data signing/)
  assert.equal(betCalls(s.calls).length, 0); noKey(s.cli)
})

// ---- retry rule ----
test('retry rule: a "retry" error resends the IDENTICAL request, with no second signature', async () => {
  T = 1_800_000_000; const s = setup(); const id = await prepared(s)
  s.state.relayQueue.push({ status: 429, body: { error: 'RateLimited', retryAfterSeconds: 20 } })
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /Resend the identical request after 20 seconds/)
  T += 25
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 0, txt(s.cli))
  const bets = betCalls(s.calls); assert.equal(bets.length, 2); assert.deepEqual(bets[0].body, bets[1].body)
  assert.equal(signCalls(s.calls).length, 1)
  T = 1_800_000_000
})
test('retry rule: a retry that would outlive the authorization is abandoned, never re-signed', async () => {
  T = 1_800_000_000; const s = setup(); const id = await prepared(s)
  s.state.relayQueue.push({ status: 503, body: { error: 'RelayUnderfunded' } })
  await s.cli.run(['bet', '--confirm', id]); T += 570
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /about to expire/)
  assert.equal(signCalls(s.calls).length, 1); assert.equal(betCalls(s.calls).length, 1); T = 1_800_000_000
})
test('DuplicateSubmission / SubmissionPending: check the chain, never re-sign; inside the lock nothing is resent', async () => {
  for (const err of [{ error: 'DuplicateSubmission', lockSeconds: 300 }, { error: 'SubmissionPending', txHash: '0x' + 'cd'.repeat(32) }]) {
    T = 1_800_000_000; const s = setup(); const id = await prepared(s)
    s.state.relayQueue.push({ status: err.error === 'SubmissionPending' ? 504 : 409, body: err })
    assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /Do not re-sign/)
    T += 30
    assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /Do not re-sign\. Check again after that/)
    assert.equal(signCalls(s.calls).length, 1); assert.equal(betCalls(s.calls).length, 1)
  }
  T = 1_800_000_000
})
test('status path: if the bet landed, report it and do not resend; if no bet and the lock passed, resend identical; if expired, abandon', async () => {
  T = 1_800_000_000
  // landed
  let s = setup(); let id = await prepared(s)
  s.state.relayQueue.push({ status: 504, body: { error: 'SubmissionPending', txHash: '0x' + 'ee'.repeat(32) } })
  await s.cli.run(['bet', '--confirm', id])
  s.w.bets[MK2.toLowerCase()] = [{ bettor: wallet.address, stake: 10_000_000n, greaterThan: false, lockedZ: -35000n, claimed: false }]
  T += 60; assert.equal(await s.cli.run(['bet', '--confirm', id]), 0); assert.match(txt(s.cli), /The bet did land/)
  assert.equal(betCalls(s.calls).length, 1)
  // no bet, lock passed, still valid -> identical resend
  T = 1_800_000_000; s = setup(); id = await prepared(s)
  s.state.relayQueue.push({ status: 502, body: { error: 'SubmissionFailed' } })
  await s.cli.run(['bet', '--confirm', id]); T += 310
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 0, txt(s.cli))
  const b = betCalls(s.calls); assert.equal(b.length, 2); assert.deepEqual(b[0].body, b[1].body); assert.equal(signCalls(s.calls).length, 1)
  // no bet, authorization expired -> abandoned, a new prepare is required
  T = 1_800_000_000; s = setup(); id = await prepared(s)
  s.state.relayQueue.push({ status: 502, body: { error: 'SubmissionFailed' } })
  await s.cli.run(['bet', '--confirm', id]); T += 700
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /can never be used/)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /finished/)
  assert.equal(signCalls(s.calls).length, 1); T = 1_800_000_000
})
test('terminal errors (market closed, nonce, etc.) end the intent; a new prepare is required', async () => {
  const s = setup(); const id = await prepared(s)
  s.state.relayQueue.push({ status: 409, body: { error: 'BettingIsClosed' } })
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /Betting on this market has closed/)
  assert.equal(await s.cli.run(['bet', '--confirm', id]), 1); assert.match(txt(s.cli), /finished/)
  assert.equal(betCalls(s.calls).length, 1)
})
test('every relay error in AGENTS.md maps to a one-line explanation and an action', () => {
  const rows = [[429, 'RateLimited', 'retry'], [400, 'InvalidRequest', 'stop'], [400, 'InvalidBettor', 'stop'], [404, 'MarketNotFound', 'stop'], [409, 'UnsupportedMarket', 'stop'],
    [400, 'BadAuthorizationNonce', 'resign'], [400, 'BelowMinBet', 'resign'], [400, 'AuthorizationExpired', 'resign'], [429, 'TooManyFailedSubmissions', 'stop'],
    [409, 'DuplicateSubmission', 'status'], [503, 'LockServiceUnavailable', 'retry'], [409, 'BettingIsClosed', 'stop'], [409, 'MarketEnded', 'stop'], [409, 'MarketFull', 'stop'],
    [409, 'MarketPaused', 'retry'], [409, 'FeeTransferFailed', 'stop'], [422, 'AuthorizationRejected', 'resign'], [400, 'SimulationReverted', 'stop'], [502, 'RpcError', 'retry'],
    [503, 'RelayNotConfigured', 'retry'], [503, 'RelayUnderfunded', 'retry'], [502, 'SubmissionFailed', 'status'], [504, 'SubmissionPending', 'status'],
    [502, 'SubmissionReverted', 'status'], [500, 'CustodyInvariantViolated', 'stop'], [500, 'InternalError', 'status']]
  for (const [st, error, kind] of rows) { const x = explainBetError(st, { error, retryAfterSeconds: 7 }); assert.equal(x.kind, kind, error); assert.ok(x.line.length > 5 && x.action.length > 5, error); assert.ok(!x.line.includes('\n')) }
  const reasons = { InvalidSignature: 'resign', AuthorizationUsedOrCanceled: 'status', AuthorizationNotYetValid: 'retry', AuthorizationExpired: 'resign', InsufficientUsdcBalance: 'retry', AccountBlacklisted: 'stop', UsdcPaused: 'retry' }
  for (const [reason, kind] of Object.entries(reasons)) assert.equal(explainBetError(422, { error: 'AuthorizationRejected', reason }).kind, kind, reason)
  assert.equal(explainBetError(418, {}).kind, 'stop')
  assert.equal(explainBetError(429, { error: 'RateLimited', retryAfterSeconds: 7 }).wait, 7)
})

// ---- status and claim ----
test('status: reads the wallet\'s bets on a market from the chain (free) and prints locked lines', async () => {
  const s = setup(); s.w.bets[MK2.toLowerCase()] = [{ bettor: wallet.address, stake: 10_000_000n, greaterThan: false, lockedZ: -35000n, claimed: false }]
  assert.equal(await s.cli.run(['status', 'Packers Cowboys']), 0)
  assert.match(txt(s.cli), /Bet 0: 10\.00 USDC\. Cowboys -3\.5/); assert.match(txt(s.cli), /Not claimed/)
  assert.equal(s.calls.filter((c) => c.host === 'evensteven.bet').length, 0)
})
test('claim: POSTs marketAddress and bettor, prints the exact claiming sentence, handles nothing-to-claim and errors', async () => {
  let s = setup(); s.state.claimQueue.push({ status: 200, body: { success: true, claimedCount: 1, remainingCount: 0, amount: '19600000', txHashes: ['0x' + 'aa'.repeat(32)], txHash: '0x', bettor: wallet.address, marketAddress: MK2 } })
  assert.equal(await s.cli.run(['claim', 'Packers Cowboys']), 0)
  const c = s.calls.find((x) => x.path === '/api/claim'); assert.deepEqual(c.body, { marketAddress: getAddress(MK2), bettor: wallet.address })
  assert.match(txt(s.cli), /Claimed 1 bet\(s\).*19\.60 USDC/); assert.ok(s.cli.lines.includes(CLAIM_SENTENCE)); noKey(s.cli)
  s = setup(); assert.equal(await s.cli.run(['claim', 'Packers Cowboys']), 0); assert.match(txt(s.cli), /Nothing claimable/); assert.ok(s.cli.lines.includes(CLAIM_SENTENCE))
  s = setup(); s.state.claimQueue.push({ status: 503, body: { error: 'RelayUnderfunded' } })
  assert.equal(await s.cli.run(['claim', 'Packers Cowboys']), 1); assert.match(txt(s.cli), /claim directly with a little ETH/); assert.ok(s.cli.lines.includes(CLAIM_SENTENCE))
  assert.ok(explainClaimError(409, { error: 'UnsupportedMarket' }).action.includes('directly'))
})
test('the claiming sentence is exactly the approved one', () => {
  assert.equal(CLAIM_SENTENCE, 'Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.')
})

// ---- key handling ----
test('missing Bankr config fails clearly; the key is sent only to api.bankr.bot and never printed', async () => {
  const s = setup(); fs.rmSync(path.join(s.dir, 'config.json'))
  assert.equal(await s.cli.run(['status', 'Packers']), 1); assert.match(txt(s.cli), /Bankr config not found/)
  const t = setup(); const id = await prepared(t); await t.cli.run(['bet', '--confirm', id])
  assert.ok(t.calls.filter((c) => c.host !== 'api.bankr.bot').every((c) => c.key === undefined), 'key never sent to the relay')
  assert.ok(t.calls.filter((c) => c.host === 'api.bankr.bot').every((c) => c.key === KEY))
  noKey(t.cli)
  assert.ok(!fs.readFileSync(path.join(t.dir, 'state', 'intents', id + '.json'), 'utf8').includes(KEY), 'key not written to the intent file')
})
test('no SKILL-facing output mentions builder codes, points, affiliates or earnings', async () => {
  const s = setup(); await s.cli.run(['markets']); await s.cli.run(['odds', 'packers']); const id = await prepared(s); await s.cli.run(['bet', '--confirm', id]); await s.cli.run(['status', 'packers']); await s.cli.run(['claim', 'packers'])
  assert.doesNotMatch(txt(s.cli), /builder|points|affiliate|earn|referral|permissionless/i)
})
