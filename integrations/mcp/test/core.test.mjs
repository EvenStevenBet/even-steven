import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { encodeAbiParameters, getAddress } from 'viem'
import { createCore } from '../src/core.mjs'
import { deriveNonce, CLAIM_SENTENCE, FACTORY, USDC } from '../src/shared.mjs'
import { wallet, other, MK1, MK2, MK3, FOREIGN, SALT, NOW, world, chain, signTd, okBet } from './helpers.mjs'

function setup(over = {}, coreOver = {}) {
  const w = world(over); const pc = chain(w); const fetches = []; const queue = []
  const fetchImpl = async (url, init = {}) => { fetches.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    const r = queue.shift() ?? { status: 200, body: okBet() }; return { status: r.status, ok: r.status < 300, text: async () => JSON.stringify(r.body) } }
  const core = createCore({ publicClient: pc, fetchImpl, now: () => NOW, randomSalt: () => SALT, ...coreOver })
  return { core, w, pc, fetches, queue }
}
async function prepared(s, args = {}) {
  const p = await s.core.prepareBet({ game: 'Packers Cowboys', side: 'away', stake: '10', bettor: wallet.address, ...args })
  assert.equal(p.status, 'ready', JSON.stringify(p)); return p
}
const submitArgs = async (p, acct = wallet) => ({ ...p.relayPayload, signature: await signTd(acct, p.typedData) })

test('list_markets: open markets with a readable line and pools; free chain read, no HTTP', async () => {
  const s = setup(); const r = await s.core.listMarkets({})
  assert.equal(r.markets.length, 3); const m = r.markets.find((x) => x.home === 'Packers')
  assert.equal(m.line, 'Cowboys favored by 3.5'); assert.equal(m.homePool, '30000000'); assert.equal(m.isOpen, true)
  assert.equal(s.fetches.length, 0)
  const all = setup({ open: [] }); assert.equal((await all.core.listMarkets({})).markets.length, 0); assert.equal((await all.core.listMarkets({ all: true })).markets.length, 3)
})
test('get_quote: chain reads only, never an HTTP call (no x402), gross, no promises; ambiguity asks', async () => {
  const s = setup(); const q = await s.core.getQuote({ game: 'packers', stake: '10' })
  assert.equal(s.fetches.length, 0); assert.equal(q.sides.length, 2); assert.match(q.sides[1].pick, /^Cowboys -3\.5: you win if the Cowboys win by 4 or more/)
  assert.match(q.note, /set at settlement from the final pool/); assert.doesNotMatch(JSON.stringify(q), /profit|guarantee|\$100/i)
  const a = await s.core.getQuote({ game: 'cowboys' }); assert.ok(a.ask); assert.equal(a.options.length, 2)
})

// ---- prepare_bet ----
test('prepare_bet: typed data is exactly a USDC ReceiveWithAuthorization with decimal-string uints; nonce commits to the side', async () => {
  const p = await prepared(await setup())
  assert.deepEqual(p.typedData.domain, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC })
  assert.equal(p.typedData.primaryType, 'ReceiveWithAuthorization'); assert.deepEqual(Object.keys(p.typedData.types), ['ReceiveWithAuthorization'])
  assert.deepEqual(p.typedData.message, { from: wallet.address, to: MK2, value: '10200000', validAfter: '0', validBefore: String(NOW + 600), nonce: deriveNonce(SALT, false) })
  assert.deepEqual(p.relayPayload, { marketAddress: MK2, bettor: wallet.address, greaterThan: false, stake: '10000000', validAfter: '0', validBefore: String(NOW + 600), nonce: deriveNonce(SALT, false), salt: SALT })
  assert.equal(p.total, '10200000')
})
test('prepare_bet: confirmation text keeps the value order and the fee read from the market', async () => {
  const p = await prepared(setup({ fee: 300n }))
  const t = p.confirmationText
  assert.ok(t.indexOf('1. Even money') < t.indexOf('2. The early line') && t.indexOf('2. The early line') < t.indexOf('3. Cost'))
  assert.match(t, /flat 3% fee on your stake, paid upfront\. Stake 10\.00 USDC \+ fee 0\.30 USDC = total 10\.30 USDC/)
  assert.match(t, /this line locks when your bet lands/); assert.doesNotMatch(t, /profit|guarantee|\$100|builder|points|affiliate/i)
})
test('prepare_bet: bettor required, stake limits, ambiguity and unknown side ask, closed and foreign markets refused', async () => {
  const s = setup()
  assert.ok((await s.core.prepareBet({ game: 'Packers', side: 'home', stake: '5', bettor: 'nope' })).error)
  await assert.rejects(s.core.prepareBet({ game: 'Packers', side: 'home', stake: '0.5', bettor: wallet.address }), /minimum stake is 1 USDC/)
  await assert.rejects(s.core.prepareBet({ game: 'Packers', side: 'home', stake: '26', bettor: wallet.address }), /maximum stake of 25/)
  assert.ok((await s.core.prepareBet({ game: 'cowboys', side: 'home', stake: '5', bettor: wallet.address })).ask)
  assert.ok((await s.core.prepareBet({ game: 'Packers Cowboys', side: 'cheesehead', stake: '5', bettor: wallet.address })).ask)
  assert.match((await s.core.prepareBet({ game: FOREIGN, side: 'home', stake: '5', bettor: wallet.address })).error, /not created by Factory v1\.6/)
  s.w.markets[MK2.toLowerCase()].open = false
  assert.match((await s.core.prepareBet({ game: MK2, side: 'home', stake: '5', bettor: wallet.address })).error, /closed/)
  assert.equal(s.fetches.length, 0, 'prepare never calls the relay')
})
test('prepare_bet: ES_MAX_STAKE style override raises the cap', async () => {
  const s = setup({}, { maxStake: 100 }); assert.equal((await s.core.prepareBet({ game: 'Packers', side: 'home', stake: '90', bettor: wallet.address })).status, 'ready')
})

// ---- submit_bet: re-derives and verifies every field ----
test('submit_bet: a correctly signed payload is posted to /api/bet exactly, nothing added, locked line returned', async () => {
  const s = setup(); const p = await prepared(s); const args = await submitArgs(p)
  const r = await s.core.submitBet(args)
  assert.equal(r.placed, true); assert.match(r.lockedLine, /^Cowboys -3\.5: you win/); assert.match(r.txUrl, /^https:\/\/basescan\.org\/tx\/0xabab/)
  assert.equal(s.fetches.length, 1); assert.equal(s.fetches[0].url, 'https://evensteven.bet/api/bet')
  assert.deepEqual(Object.keys(s.fetches[0].body).sort(), ['bettor', 'greaterThan', 'marketAddress', 'nonce', 'salt', 'signature', 'stake', 'validAfter', 'validBefore'])
  assert.ok(!('ref' in s.fetches[0].body))
})
test('submit_bet: a lowercase bettor address is accepted and normalized', async () => {
  const s = setup(); const p = await prepared(s); const args = await submitArgs(p); args.bettor = args.bettor.toLowerCase()
  // the signature covers the checksummed form's value, which is the same address
  assert.equal((await s.core.submitBet(args)).placed, true)
})
const rejects = async (mut, re, over) => {
  const s = setup(over); const p = await prepared(s); const args = await submitArgs(p); mut(args, s, p)
  await assert.rejects(s.core.submitBet(args), re); assert.equal(s.fetches.length, 0, 'nothing reached the relay')
}
test('submit_bet: every derived field is checked before anything is posted', async () => {
  await rejects((a) => { a.extra = 1 }, /unexpected field "extra"/)
  await rejects((a) => { a.ref = 'x' }, /unexpected field "ref"/)
  await rejects((a) => { a.marketAddress = FOREIGN }, /not a market created by Factory v1\.6/)
  await rejects((a) => { a.marketAddress = 'x' }, /not an address/)
  await rejects((a) => { a.bettor = other.address }, /signature does not verify/)
  await rejects((a) => { a.stake = '10000001' }, /signature does not verify/)             // value no longer matches what was signed
  await rejects((a) => { a.stake = '500000' }, /under 1 USDC/)
  await rejects((a) => { a.stake = '26000000' }, /over this server's maximum/)
  await rejects((a) => { a.validAfter = '1' }, /validAfter must be 0/)
  await rejects((a) => { a.validBefore = String(NOW + 10) }, /expires in under 30 seconds/)
  await rejects((a) => { a.validBefore = String(NOW + 5000) }, /too far in the future/)
  await rejects((a) => { a.greaterThan = true }, /nonce is not keccak256/)                   // the side is bound to the nonce
  await rejects((a) => { a.salt = '0x' + '11'.repeat(32) }, /nonce is not keccak256/)
  await rejects((a) => { a.nonce = '0x' + '00'.repeat(32) }, /nonce is not keccak256/)
  await rejects((a) => { a.stake = 10000000 }, /decimal string/)
  await rejects((a) => { a.greaterThan = 'true' }, /greaterThan must be/)
  await rejects((a) => { a.signature = '0x1234' }, /signature does not verify/)
  await rejects((a) => { a.signature = 'zz' }, /signature must be hex/)
})
test('submit_bet: wrong-type typed data signatures do not verify (TransferWithAuthorization, wrong domain, wrong recipient)', async () => {
  for (const mutate of [
    (td) => { td.primaryType = 'TransferWithAuthorization'; td.types = { TransferWithAuthorization: td.types.ReceiveWithAuthorization } },
    (td) => { td.domain.version = '1' },
    (td) => { td.message.to = MK1 },
  ]) {
    const s = setup(); const p = await prepared(s); const td = structuredClone(p.typedData); mutate(td)
    const args = { ...p.relayPayload, signature: await signTd(wallet, td) }
    await assert.rejects(s.core.submitBet(args), /signature does not verify/); assert.equal(s.fetches.length, 0)
  }
})
test('submit_bet: closed market and market fee changes are caught (the fee is re-read)', async () => {
  const s = setup(); const p = await prepared(s); s.w.markets[MK2.toLowerCase()].open = false
  await assert.rejects(s.core.submitBet(await submitArgs(p)), /closed/)
  const t = setup(); const q = await prepared(t); t.w.fee = 300n
  await assert.rejects(t.core.submitBet(await submitArgs(q)), /signature does not verify/)   // the value the user signed is no longer stake + fee
})
test('submit_bet: a signature by another key never reaches the relay (no relay strike)', async () => {
  const s = setup(); const p = await prepared(s)
  await assert.rejects(s.core.submitBet(await submitArgs(p, other)), /does not verify/); assert.equal(s.fetches.length, 0)
})
test('submit_bet: non-65-byte signatures are accepted only for a contract wallet whose isValidSignature returns the magic value', async () => {
  const wrapSig = async (td) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, await signTd(wallet, td)])
  let s = setup({ code: '0x6080604052' }); let p = await prepared(s)
  assert.equal((await s.core.submitBet({ ...p.relayPayload, signature: await wrapSig(p.typedData) })).placed, true)
  s = setup({ code: '0x6080604052', erc1271: '0xffffffff' }); p = await prepared(s)
  await assert.rejects(s.core.submitBet({ ...p.relayPayload, signature: await wrapSig(p.typedData) }), /does not verify/)
  s = setup({ code: '0x' }); p = await prepared(s)
  await assert.rejects(s.core.submitBet({ ...p.relayPayload, signature: await wrapSig(p.typedData) }), /does not verify/)
})
test('submit_bet: relay errors are mapped with the retry rule; the identical payload can be resent', async () => {
  const s = setup(); const p = await prepared(s); const args = await submitArgs(p)
  s.queue.push({ status: 429, body: { error: 'RateLimited', retryAfterSeconds: 20 } })
  const a = await s.core.submitBet(args); assert.equal(a.placed, false); assert.equal(a.class, 'retry'); assert.match(a.action, /identical request after 20 seconds/)
  const b = await s.core.submitBet(args); assert.equal(b.placed, true)
  assert.deepEqual(s.fetches[0].body, s.fetches[1].body)
  s.queue.push({ status: 504, body: { error: 'SubmissionPending', txHash: '0x' + 'cd'.repeat(32) } })
  const c = await s.core.submitBet(args); assert.equal(c.class, 'status'); assert.match(c.action, /Do not re-sign/); assert.match(c.rule, /never sign again/)
  s.queue.push({ status: 409, body: { error: 'BettingIsClosed' } }); assert.equal((await s.core.submitBet(args)).class, 'stop')
})

// ---- status, claim ----
test('get_status: chain read, locked lines for the sides', async () => {
  const s = setup(); s.w.bets[MK2.toLowerCase()] = [{ bettor: wallet.address, stake: 10_000_000n, greaterThan: false, lockedZ: -35000n, claimed: false }]
  const r = await s.core.getStatus({ game: 'Packers Cowboys', bettor: wallet.address })
  assert.equal(r.bets[0].side, 'away'); assert.match(r.bets[0].pick, /^Cowboys -3\.5/); assert.equal(r.bets[0].claimed, false); assert.equal(s.fetches.length, 0)
  assert.match((await s.core.getStatus({ game: 'Packers', bettor: 'x' })).error, /address/)
})
test('claim: posts marketAddress and bettor, includes the exact claiming sentence, maps errors', async () => {
  const s = setup(); s.queue.push({ status: 200, body: { success: true, claimedCount: 1, remainingCount: 0, amount: '19600000', txHashes: ['0x' + 'aa'.repeat(32)] } })
  const r = await s.core.claim({ game: MK2, bettor: wallet.address })
  assert.deepEqual(s.fetches[0].body, { marketAddress: getAddress(MK2), bettor: wallet.address }); assert.equal(r.claimed, true); assert.equal(r.claimingNote, CLAIM_SENTENCE)
  s.queue.push({ status: 200, body: { claimed: [], note: 'Nothing claimable', txHashes: [], claimedCount: 0, remainingCount: 0 } })
  assert.equal((await s.core.claim({ game: MK2, bettor: wallet.address })).claimed, false)
  s.queue.push({ status: 503, body: { error: 'RelayUnderfunded' } })
  const e = await s.core.claim({ game: MK2, bettor: wallet.address }); assert.match(e.action, /little ETH/); assert.equal(e.claimingNote, CLAIM_SENTENCE)
})
test('older markets resolve by explicit address or full gameId even when not in the recent list', async () => {
  const s = setup({ all: [MK2, MK3] })
  assert.equal((await s.core.getStatus({ game: MK1, bettor: wallet.address })).market.home, 'Dolphins')
  assert.equal((await s.core.getStatus({ game: 'NFL-2026-10-18-HOME-Dolphins-AWAY-Chiefs', bettor: wallet.address })).market.home, 'Dolphins')
})

// ---- the server holds no keys and signs nothing ----
test('no key handling: the source never imports a signing or key API and never reads an environment key', () => {
  for (const f of ['core.mjs', 'server.mjs', 'shared.mjs', 'serve.mjs']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /privateKeyToAccount|generatePrivateKey|\.signTypedData\(|\.signMessage\(|\.signTransaction\(|sendTransaction|writeContract|walletClient|createWalletClient|PRIVATE_KEY|BANKR|X-API-Key|mnemonic/i, f)
  }
})
test('no copy-rule words in tool text: builder codes, points, ref, audited, profit promises', async () => {
  const { createMcpServer } = await import('../src/server.mjs')
  const src = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src.replace(/Not submitted: unexpected field/g, ''), /builder code|affiliate|points|airdrop|reward|audited|guaranteed|permissionless|at liquidity|alpha/i)
})
