// node --test scripts/x-posts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { EVEN_MONEY, assertPostable, byText, creationTimestamp, oauthHeader, parseNotBefore, requireNotBefore, parseGameId, pendingFor, postToX, render, resultText,
         runOnce, stageOf } from './x-posts.mjs'

const GID = 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys'
const M = { address: '0xaa', gameId: GID, stage: 'opened', initialZ: 35000n, currentZ: 45000n, finalSpread: 7n }

test('parseGameId', () => {
  assert.deepEqual(parseGameId(GID), { sport: 'NFL', date: '2026-10-18', month: 10, day: 18, home: 'Packers', away: 'Cowboys', game: null })
  assert.equal(parseGameId('MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G2').home, 'Red Sox')
  assert.equal(parseGameId('MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G2').game, 2)
  assert.equal(parseGameId('nonsense'), null)
})

test('line: home is quoted at -Z; away favourite when Z < 0; pick em at 0', () => {
  assert.equal(byText(35000n, 'Packers', 'Cowboys'), 'Packers by 3.5')
  assert.equal(byText(-30000n, 'Packers', 'Cowboys'), 'Cowboys by 3')
  assert.equal(byText(0n, 'Packers', 'Cowboys'), "pick'em")
})

test('result wording follows finalSpread = home - away', () => {
  assert.equal(resultText(7n, 'Packers', 'Cowboys'), 'Packers won by 7')
  assert.equal(resultText(-3n, 'Packers', 'Cowboys'), 'Cowboys won by 3')
  assert.equal(resultText(0n, 'Packers', 'Cowboys'), 'Packers and Cowboys tied')
})

test('templates are exactly the approved wording', () => {
  assert.equal(render('opened', M),
    'Cowboys at Packers is open. Line: Packers by 3.5. Back either side at even money. The spread moves to balance the pool, so $100 wins $100.')
  assert.equal(render('opened', { ...M, initialZ: 0n }),
    "Cowboys at Packers is open. Line: pick'em. Back either side at even money. The spread moves to balance the pool, so $100 wins $100.")
  assert.equal(render('closed', M), 'Betting is closed on Cowboys at Packers. Line closed at Packers by 4.5.')
  assert.equal(render('closed', { ...M, currentZ: 0n }), "Betting is closed on Cowboys at Packers. Line closed at pick'em.")
  assert.equal(render('settled', M), 'Final: Packers won by 7. Winners split the pool.')
  assert.equal(render('settled', { ...M, finalSpread: -3n }), 'Final: Cowboys won by 3. Winners split the pool.')
  assert.equal(render('settled', { ...M, finalSpread: 0n }), 'Final: Packers and Cowboys tied. Winners split the pool.')
})

test('the even-money sentence is exactly the approved one, and only the opened post carries it', () => {
  assert.equal(EVEN_MONEY, 'Back either side at even money. The spread moves to balance the pool, so $100 wins $100.')
  assert.ok(render('opened', M).endsWith(EVEN_MONEY))
  assert.ok(!render('closed', M).includes('$100') && !render('settled', M).includes('$100'))
  assert.ok(!render('opened', M).includes('Get in early'), 'sentence 2 of the pitch is not used')
})

test('no template mentions builder codes, affiliate, referral, points, 30%, market creation, fees, claims or payouts', () => {
  const forbidden = /builder|affiliate|referral|points|commission|30%|permissionless|creat|fee|2%|claim|payout|vig|profit|gasless|\dx\b|—/i
  const variants = [
    ...['opened', 'closed', 'settled'].map((e) => render(e, M)),
    render('opened', { ...M, initialZ: 0n }), render('closed', { ...M, currentZ: 0n }), render('settled', { ...M, finalSpread: 0n }),
    render('settled', { ...M, finalSpread: -3n }),
  ]
  for (const text of variants) {
    assert.doesNotMatch(text, forbidden, text)
    assert.doesNotMatch(text.replace(EVEN_MONEY, ''), /\$/, `a dollar figure outside the approved sentence: ${text}`)
  }
})

test('the forbidden-word check really fails when a template mentions one of them', () => {
  const forbidden = /builder|affiliate|referral|points|commission|30%|permissionless|creat/i
  for (const bad of ['A builder code earns', 'An affiliate code earns', 'referral', 'points', 'earns 30% of the fee', 'create markets'])
    assert.match(`Cowboys at Packers is open. ${bad}`, forbidden, bad)
})

test('every post is plain text under 280 characters, even with the longest team names', () => {
  const long = { ...M, gameId: 'NFL-2026-10-18-HOME-Jacksonville-Jaguars-AWAY-Washington-Commanders' }
  for (const e of ['opened', 'closed', 'settled']) {
    const text = render(e, long)
    assert.ok(text.length < 280, `${e}: ${text.length}`)
    assert.doesNotMatch(text, /https?:|www\.|[@#]/)
  }
})

test('a doubleheader posts different text for each game', () => {
  const g1 = render('opened', { ...M, gameId: 'MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G1' })
  const g2 = render('opened', { ...M, gameId: 'MLB-2026-06-01-HOME-Red-Sox-AWAY-Blue-Jays-G2' })
  assert.notEqual(g1, g2)
  assert.match(g1, /^Blue Jays at Red Sox, game 1 is open\./)
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

function harness(markets, postResults) {
  const calls = [], saves = []
  const queue = [...postResults]
  return { calls, saves, io: { now: () => 'T', log() {}, markets: async () => markets,
    post: async t => { calls.push(t); return queue.shift() }, save: s => saves.push(JSON.parse(JSON.stringify(s))) } }
}
const cfg = { enabled: true, dryRun: false, maxPosts: 3, notBeforeSec: null }

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

test('a cancelled or refund-mode market produces no post, live or dry', async () => {
  for (const c of [cfg, { ...cfg, dryRun: true }]) {
    const h = harness([{ ...M, stage: stageOf({ bettingOpen: false, settled: false, canceled: true, refundMode: true }) },
                       { ...M, address: '0xcc', stage: stageOf({ bettingOpen: false, settled: true, canceled: false, refundMode: true }) }], [])
    const r = await runOnce({ disabled: null, markets: {} }, h.io, c)
    assert.deepEqual([r.posted.length, r.wouldPost.length, h.calls.length], [0, 0, 0])
  }
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

// ---- X_POSTS_NOT_BEFORE: the go-live cutoff ----
const NOW = 1_792_000_000 // a fixed "now", epoch seconds

test('parseNotBefore: ISO times and UTC dates are read exactly, anything else is an error', () => {
  assert.equal(parseNotBefore('2026-10-26'), Date.parse('2026-10-26T00:00:00Z') / 1000)
  assert.equal(parseNotBefore('2026-10-26T00:20:00Z'), Date.parse('2026-10-26T00:20:00Z') / 1000)
  assert.equal(parseNotBefore('2026-10-25T17:20:00-07:00'), Date.parse('2026-10-26T00:20:00Z') / 1000)
  assert.equal(parseNotBefore(' 2026-10-26T00:20:00Z '), Date.parse('2026-10-26T00:20:00Z') / 1000)
  for (const bad of ['2026-10-26 00:20', 'tomorrow', '', '2026-13-45', '10/26/2026', '1792000000', '2026-10-26T00:20:00']) assert.throws(() => parseNotBefore(bad), /X_POSTS_NOT_BEFORE/, bad)
})

test('live mode fails with a clear error when X_POSTS_NOT_BEFORE is unset; a dry run does not', () => {
  for (const unset of [undefined, null, '', '   ']) assert.throws(() => requireNotBefore(unset, { live: true }), /X_POSTS_NOT_BEFORE is not set/)
  for (const unset of [undefined, '']) assert.equal(requireNotBefore(unset, { live: false }), null)
  assert.equal(requireNotBefore('2026-10-26', { live: true }), parseNotBefore('2026-10-26'))
  assert.throws(() => requireNotBefore('garbage', { live: false }), /X_POSTS_NOT_BEFORE must be/)
})

test('the script itself refuses to start live without X_POSTS_NOT_BEFORE, before any network call', () => {
  const script = fileURLToPath(new URL('./x-posts.mjs', import.meta.url))
  const env = { PATH: process.env.PATH, X_POSTS_ENABLED: 'true', DRY_RUN: 'false', RPC_URL: 'http://127.0.0.1:9', STATE_FILE: path.join(os.tmpdir(), 'x-posts-test-state.json'),
    X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' }
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /X_POSTS_NOT_BEFORE is not set/)
  assert.doesNotMatch(r.stdout + r.stderr, /ECONNREFUSED|fetch failed|HTTP request failed/, 'it failed before touching the RPC')
  // and with the variable set it gets past that check (then fails on the unreachable RPC, which is fine here)
  const r2 = spawnSync(process.execPath, [script], { env: { ...env, X_POSTS_NOT_BEFORE: '2026-10-26' }, encoding: 'utf8', timeout: 30_000 })
  assert.doesNotMatch(r2.stderr, /X_POSTS_NOT_BEFORE is not set/)
})

test('with the cutoff set to now, an old settled market produces no post (live and dry)', async () => {
  const oldSettled = { ...M, address: '0xold', stage: 'settled', finalSpread: 7n, eventAt: NOW - 3 * 86400 }
  for (const c of [{ ...cfg, notBeforeSec: NOW }, { ...cfg, dryRun: true, notBeforeSec: NOW }]) {
    const h = harness([oldSettled], [])
    const r = await runOnce({ disabled: null, markets: {} }, h.io, c)
    assert.deepEqual([r.posted.length, r.wouldPost.length, h.calls.length, h.saves.length], [0, 0, 0, 0])
  }
})

test('the cutoff is inclusive, and later events post: closed after it posts, opened before it does not', async () => {
  const mk = (address, stage, eventAt) => ({ ...M, address, stage, eventAt, finalSpread: 7n })
  const h = harness([mk('0xa', 'settled', NOW), mk('0xb', 'closed', NOW + 60), mk('0xc', 'opened', NOW - 1), mk('0xd', 'closed', NOW - 86400)],
    [1, 2, 3].map((i) => ({ ok: true, status: 200, id: String(i) })))
  const r = await runOnce({ disabled: null, markets: {} }, h.io, { ...cfg, notBeforeSec: NOW })
  assert.deepEqual(r.posted.map((p) => [p.market, p.event]), [['0xa', 'settled'], ['0xb', 'closed']])
})

test('an event time that cannot be proven is skipped, never guessed', async () => {
  const h = harness([{ ...M, address: '0xe', stage: 'opened', eventAt: null }], [])
  const logs = []
  h.io.log = (e) => logs.push(e)
  const r = await runOnce({ disabled: null, markets: {} }, h.io, { ...cfg, dryRun: true, notBeforeSec: NOW })
  assert.deepEqual([r.posted.length, r.wouldPost.length], [0, 0])
  assert.deepEqual(logs, ['skipped_event_time_unknown'])
})

test('without a cutoff (dry run only) nothing is filtered by time', async () => {
  const h = harness([{ ...M, address: '0xf', stage: 'settled', finalSpread: 7n }], [])
  const r = await runOnce({ disabled: null, markets: {} }, h.io, { ...cfg, dryRun: true, notBeforeSec: null })
  assert.equal(r.wouldPost.length, 1)
})

test('creationTimestamp: binary search for the first block with code, then that block\'s timestamp', async () => {
  const FIRST = 1234n
  let calls = 0
  const pub = { getBlockNumber: async () => 5000n, getCode: async ({ blockNumber }) => { calls++; return blockNumber >= FIRST ? '0x6080' : '0x' },
    getBlock: async ({ blockNumber }) => ({ timestamp: 1_000_000n + blockNumber }) }
  assert.equal(await creationTimestamp(pub, '0xabc'), 1_000_000 + 1234)
  assert.ok(calls <= 16, `used ${calls} getCode calls`)
  assert.equal(await creationTimestamp({ ...pub, getCode: async () => { throw new Error('state not available') } }, '0xabc'), null)
  assert.equal(await creationTimestamp({ ...pub, getCode: async () => '0x' }, '0xabc'), null, 'no code even now')
})

test('a cancelled or refund-mode market is skipped without any event-time noise', async () => {
  const h = harness([{ ...M, address: '0xg', stage: null }], [])
  const logs = []
  h.io.log = (e) => logs.push(e)
  const r = await runOnce({ disabled: null, markets: {} }, h.io, { ...cfg, dryRun: true, notBeforeSec: NOW })
  assert.deepEqual([r.posted.length, r.wouldPost.length, logs.length], [0, 0, 0])
})
