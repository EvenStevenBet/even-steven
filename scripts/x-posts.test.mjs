// node --test scripts/x-posts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertPostable, eligible, lineText, oauthHeader, parseGameId, pendingFor, postToX, render, resultText,
         runOnce, stageOf } from './x-posts.mjs'

const GID = 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys'
const M = { address: '0xaa', gameId: GID, stage: 'opened', initialZ: 35000n, currentZ: 45000n, stakes: 1234_500000n, finalSpread: 7n }

test('parseGameId', () => {
  assert.deepEqual(parseGameId(GID), { sport: 'NFL', date: '2026-10-18', month: 10, day: 18, home: 'Packers', away: 'Cowboys', game: null })
  assert.equal(parseGameId('MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G2').home, 'Red Sox')
  assert.equal(parseGameId('MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G2').game, 2)
  assert.equal(parseGameId('nonsense'), null)
})

test('line: home is quoted at -Z; away favourite when Z < 0; pick em at 0', () => {
  assert.equal(lineText(35000n, 'Packers', 'Cowboys'), 'Packers -3.5')
  assert.equal(lineText(-30000n, 'Packers', 'Cowboys'), 'Cowboys -3')
  assert.equal(lineText(0n, 'Packers', 'Cowboys'), "pick'em")
})

test('result wording follows finalSpread = home - away', () => {
  assert.equal(resultText(7n, 'Packers', 'Cowboys'), 'Packers won by 7')
  assert.equal(resultText(-3n, 'Packers', 'Cowboys'), 'Cowboys won by 3')
  assert.equal(resultText(0n, 'Packers', 'Cowboys'), 'Packers and Cowboys tied')
})

test('templates', () => {
  assert.equal(render('opened', M),
    'Market open: Cowboys at Packers (NFL, Oct 18).\nLine: Packers -3.5.\nWinners split the pool. One flat 2% fee on stake.')
  assert.equal(render('closed', M),
    'Betting closed: Cowboys at Packers (NFL, Oct 18).\nClosing line: Packers -4.5.\nStakes in the pool: $1,234.')
  assert.match(render('closed', { ...M, stakes: 0n }), /No bets were placed\.$/)
  assert.equal(render('settled', M),
    'Final: Packers won by 7 (Cowboys at Packers, NFL, Oct 18).\nWinners can claim their payouts now.')
})

test('templates reject unsafe team names and any link, mention or hashtag', () => {
  assert.throws(() => render('opened', { ...M, gameId: 'NFL-2026-10-18-HOME-Pack@ers-AWAY-Cowboys' }))
  assert.throws(() => render('opened', { ...M, gameId: 'NFL-2026-10-18-HOME-evensteven.bet-AWAY-Cowboys' }))
  assert.throws(() => assertPostable('see evensteven.bet'))
  assert.throws(() => assertPostable('https://x.com'))
  assert.throws(() => assertPostable('#bets'))
  assert.throws(() => assertPostable('x'.repeat(281)))
  assert.doesNotThrow(() => assertPostable('Line: Packers -3.5.'))
})

test('stageOf never posts a cancel or refund', () => {
  assert.equal(stageOf({ bettingOpen: true, settled: false, canceled: false, refundMode: false }), 'opened')
  assert.equal(stageOf({ bettingOpen: false, settled: false, canceled: false, refundMode: false }), 'closed')
  assert.equal(stageOf({ bettingOpen: false, settled: true, canceled: false, refundMode: false }), 'settled')
  assert.equal(stageOf({ bettingOpen: false, settled: true, canceled: false, refundMode: true }), null)
  assert.equal(stageOf({ bettingOpen: false, settled: false, canceled: true, refundMode: true }), null)
})

test('pendingFor posts only the latest stage reached and once', () => {
  assert.deepEqual(pendingFor('opened', {}), { post: 'opened', skip: [] })
  assert.deepEqual(pendingFor('opened', { opened: {} }), { post: null, skip: [] })
  assert.deepEqual(pendingFor('closed', { opened: {} }), { post: 'closed', skip: [] })
  assert.deepEqual(pendingFor('closed', {}), { post: 'closed', skip: ['opened'] })
  assert.deepEqual(pendingFor('settled', { opened: {} }), { post: 'settled', skip: ['closed'] })
  assert.deepEqual(pendingFor('settled', { opened: {}, closed: {}, settled: {} }), { post: null, skip: [] })
  assert.deepEqual(pendingFor(null, {}), { post: null, skip: [] })
})

test('eligible respects notBefore', () => {
  assert.equal(eligible(GID, { notBefore: '2026-10-18' }), true)
  assert.equal(eligible(GID, { notBefore: '2026-10-19' }), false)
  assert.equal(eligible('garbage', { notBefore: '2026-01-01' }), false)
})

function harness(markets, postResults) {
  const calls = [], saves = []
  const queue = [...postResults]
  return { calls, saves, io: { now: () => 'T', log() {}, markets: async () => markets,
    post: async t => { calls.push(t); return queue.shift() }, save: s => saves.push(JSON.parse(JSON.stringify(s))) } }
}
const cfg = { enabled: true, dryRun: false, maxPosts: 3, config: { notBefore: '2026-10-18' } }

test('a rerun never double-posts', async () => {
  const h = harness([M], [{ ok: true, status: 200, id: '1' }])
  const state = { disabled: null, markets: {} }
  const a = await runOnce(state, h.io, cfg)
  assert.equal(a.posted.length, 1)
  const b = await runOnce(state, h.io, cfg)
  assert.equal(b.posted.length, 0)
  assert.equal(h.calls.length, 1)
})

test('dry run and disabled flag post nothing and write nothing', async () => {
  for (const c of [{ ...cfg, dryRun: true }, { ...cfg, enabled: false }]) {
    const h = harness([M], [])
    const state = { disabled: null, markets: {} }
    const r = await runOnce(state, h.io, c)
    assert.equal(r.wouldPost.length, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.saves.length, 0)
    assert.deepEqual(state.markets, {})
  }
})

test('any X failure disables posting, records the event, stops, and is never retried', async () => {
  const m2 = { ...M, address: '0xbb' }
  const h = harness([M, m2], [{ ok: false, status: 403, id: null, detail: 'Forbidden' }])
  const state = { disabled: null, markets: {} }
  const r = await runOnce(state, h.io, cfg)
  assert.match(r.halted, /403/)
  assert.equal(h.calls.length, 1)
  assert.ok(state.disabled)
  assert.equal(state.markets['0xaa'].opened.failed, 403)
  const again = await runOnce(state, h.io, cfg)
  assert.match(again.halted, /disabled/)
  assert.equal(h.calls.length, 1)
})

test('per-run cap', async () => {
  const ms = ['0x1', '0x2', '0x3', '0x4'].map(address => ({ ...M, address }))
  const h = harness(ms, ms.map(() => ({ ok: true, status: 200, id: 'x' })))
  const r = await runOnce({ disabled: null, markets: {} }, h.io, cfg)
  assert.equal(r.posted.length, 3)
})

test('postToX: success, HTTP error, and no-response all come back as data', async () => {
  const creds = { apiKey: 'k', apiSecret: 's', accessToken: 't', accessTokenSecret: 'ts' }
  const ok = await postToX('hi', creds, async () => ({ ok: true, status: 201, json: async () => ({ data: { id: '9' } }) }))
  assert.deepEqual([ok.ok, ok.id], [true, '9'])
  const bad = await postToX('hi', creds, async () => ({ ok: false, status: 429, statusText: 'Too Many', json: async () => ({ title: 'Too Many Requests' }) }))
  assert.deepEqual([bad.ok, bad.status], [false, 429])
  const none = await postToX('hi', creds, async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) })
  assert.deepEqual([none.ok, none.status], [false, 0])
})

test('oauthHeader is deterministic and never carries a secret', () => {
  const h = oauthHeader('POST', 'https://api.x.com/2/tweets',
    { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats' }, { nonce: 'n', timestamp: '1' })
  assert.match(h, /^OAuth /)
  assert.match(h, /oauth_signature_method="HMAC-SHA1"/)
  assert.equal(h, oauthHeader('POST', 'https://api.x.com/2/tweets',
    { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats' }, { nonce: 'n', timestamp: '1' }))
  assert.ok(!/oauth_(consumer_)?secret|"cs"|"ats"/.test(h))
})
