// node --test scripts/x-search.test.mjs
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xSearch } from './x-search-client.mjs'
import { applyEnv, buildQuery, cell, estimateMicro, expiredTabs, fixtureSearch, googleStore, memoryStore, planRequest, processResponse, requireSecrets, runJob, validateConfig, toMicro } from './x-search.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const fixture = JSON.parse(read('scripts/fixtures/x-search-fixture.json'))
const baseCfg = () => validateConfig({ queries: ['"polymarket bot"', '"kalshi bot"'], maxPostsPerQuery: 50, dailyCapUsd: 3, monthlyCapUsd: 25 })
const jobFiles = ['scripts/x-search.mjs', 'scripts/x-search-client.mjs', '.github/workflows/x-search.yml', 'data/x-search-queries.json']

// ── Req 1: read-only, app-only, one endpoint ─────────────────────────────────

test('SAFETY: the X client has one endpoint, no verb override, no signing', () => {
  const src = read('scripts/x-search-client.mjs')
  assert.deepEqual(src.match(/\/2\/[A-Za-z0-9_/]+/g), ['/2/tweets/search/recent'])
  assert.doesNotMatch(src, /method\s*:|\.method|POST|PUT|PATCH|DELETE/)
  assert.equal((src.match(/fetchFn\(/g) ?? []).length, 1)
  assert.match(src, /Authorization: `Bearer \$\{token\}`/)
})

test('SAFETY: no other X endpoint or OAuth user-context signing anywhere in the job', () => {
  for (const f of jobFiles) {
    const src = read(f)
    for (const m of src.match(/\/2\/[A-Za-z0-9_/]+/g) ?? []) assert.equal(m, '/2/tweets/search/recent', `${f}: ${m}`)
    assert.doesNotMatch(src, /oauth_signature|oauth_consumer_key|oauth_nonce|oauth_token|HMAC-SHA1|createHmac|OAuth\s+oauth/i, f)
    assert.doesNotMatch(src, /X_ACCESS_TOKEN|X_API_KEY|X_API_SECRET|X_CONSUMER|ACCESS_TOKEN_SECRET|X_READ_BEARER|\/2\/(users|dm|lists|likes|compliance|spaces)|\/1\.1\//i, f)
  }
  const hosts = new Set(read('scripts/x-search.mjs').concat(read('scripts/x-search-client.mjs')).match(/https?:\/\/[^\s'"`/$]+/g).map(h => h.replace(/^https?:\/\//, '')))
  for (const h of hosts) assert.ok(['api.x.com', 'x.com', 'oauth2.googleapis.com', 'sheets.googleapis.com', 'www.googleapis.com'].includes(h), `unexpected host ${h}`)
  const wf = read('.github/workflows/x-search.yml')
  assert.deepEqual([...new Set(wf.match(/secrets\.X_[A-Z_]+/g))], ['secrets.X_BEARER_TOKEN'])
})

test('SAFETY: at runtime every X request is a GET to the search endpoint with a Bearer header', async () => {
  const calls = []
  const fetchFn = async (url, init) => { calls.push({ url: new URL(url), init }); return { ok: true, json: async () => ({ data: [], meta: { result_count: 0 } }) } }
  await xSearch('tok', fetchFn)({ query: '(a) -is:retweet', maxResults: 10, sinceId: '5' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.x.com/2/tweets/search/recent')
  assert.ok(!calls[0].init.method || calls[0].init.method === 'GET')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  assert.equal(calls[0].url.searchParams.get('since_id'), '5')
})

test('SAFETY: post text is never sent anywhere: no model SDK, process runner, eval, or Grok/other connector in the job', () => {
  const banned = new RegExp(['anthrop' + 'ic', 'open' + 'ai', 'api\\.x\\.ai', 'gr' + 'ok', 'child_' + 'process', 'eval\\(', 'new Function', 'spawn', 'exec\\('].join('|'), 'i')
  for (const f of jobFiles) assert.doesNotMatch(read(f), banned, f)
  const hostsInScript = read('scripts/x-search.mjs').match(/https?:\/\/[^\s'"`/$]+/g)
  assert.ok(hostsInScript.every(h => !/gr[o]k|x\.ai/i.test(h)))
})

// ── Req 2: config ────────────────────────────────────────────────────────────

test('the shipped config is valid and excludes retweets', () => {
  const cfg = validateConfig(JSON.parse(read('data/x-search-queries.json')))
  assert.equal(cfg.excludeRetweets, true)
  for (const q of cfg.queries) assert.match(buildQuery(q, cfg), /-is:retweet/)
})

test('config validation: count, length, control chars, duplicates, unknown keys, bad caps', () => {
  const ok = { queries: ['a'], dailyCapUsd: 1, monthlyCapUsd: 5 }
  assert.ok(validateConfig(ok))
  assert.throws(() => validateConfig({ ...ok, queries: [] }))
  assert.throws(() => validateConfig({ ...ok, queries: Array.from({ length: 26 }, (_, i) => `q${i}`) }), /at most 25/)
  assert.throws(() => validateConfig({ ...ok, queries: ['x'.repeat(401)] }), /max 400/)
  assert.throws(() => validateConfig({ ...ok, queries: ['a\nb'] }), /control/)
  assert.throws(() => validateConfig({ ...ok, queries: ['a', 'a'] }), /duplicate/)
  assert.throws(() => validateConfig({ ...ok, postToX: true }), /unknown key/)
  assert.throws(() => validateConfig({ ...ok, dailyCapUsd: 0 }))
  assert.throws(() => validateConfig({ ...ok, maxPostsPerQuery: 5 }))
})

test('retweets excluded by default, only an explicit false opts out; no double operator', () => {
  assert.equal(buildQuery('"a b"', { lang: 'en' }), '("a b") -is:retweet lang:en')
  assert.equal(buildQuery('a', { excludeRetweets: false }), '(a)')
  assert.equal(buildQuery('a -is:retweet', {}), '(a -is:retweet)')
})

test('env overrides tighten a run and reject junk', () => {
  const cfg = baseCfg()
  const o = applyEnv(cfg, { X_SEARCH_MAX_QUERIES: '1', X_SEARCH_MAX_POSTS_PER_QUERY: '10', X_SEARCH_DAILY_CAP_USD: '1' })
  assert.deepEqual([o.queries.length, o.maxPostsPerQuery, o.dailyCapUsd], [1, 10, 1])
  assert.equal(applyEnv(cfg, { X_SEARCH_MAX_QUERIES: '' }).queries.length, 2)
  assert.throws(() => applyEnv(cfg, { X_SEARCH_DAILY_CAP_USD: 'lots' }))
})

// ── Req 3: plain text cells, dedupe, since_id ────────────────────────────────

test('cells starting with = + - @ (even after whitespace) are neutralized', () => {
  for (const s of ['=SUM(1)', '+1', '-5.5', '@all', ' =1', '\t=1', '\r+1']) assert.ok(cell(s).startsWith("'"), JSON.stringify(s))
  assert.equal(cell('hello =x'), 'hello =x')
  assert.equal(cell(undefined), '')
})

test('processResponse: neutralizes, validates handles, builds links from ids, skips retweets and repeats', () => {
  const seen = new Set()
  const r = processResponse('q', fixture.responses[0], seen)
  assert.equal(r.rows.length, 3) // the retweet is dropped
  assert.ok(r.rows[0][2].startsWith("'=HYPERLINK"))
  assert.equal(r.rows[0][1], 'https://x.com/alice_bets/status/1001')
  assert.ok(r.rows[0].length === 5)
  const r2 = processResponse('q2', fixture.responses[1], seen)
  assert.equal(r2.rows.length, 2) // 1002 already seen
  assert.equal(r2.rows[1][0], '') // invalid handle dropped
  assert.equal(r2.rows[1][1], 'https://x.com/i/status/2002')
})

test('a run writes values RAW only and advances since_id and seen only after the rows are written', async () => {
  const store = memoryStore()
  const r = await runJob({ cfg: baseCfg(), search: fixtureSearch(fixture), store, date: '2026-11-17', mode: 'dry-run' })
  assert.equal(r.rows.length, 5)
  assert.equal(store.tabs.get('2026-11-17').length, 5)
  assert.equal(store.state.since.size, 2)
  assert.ok([...store.state.since.values()].includes('2002'))
  assert.ok(store.state.seen.has('1002'))

  // second run: state says what was read; since_id is sent per query and ids never repeat
  const sent = []
  const store2 = { ...memoryStore(), loadState: async () => store.state, saveState: async () => {} }
  await runJob({ cfg: baseCfg(), search: async a => { sent.push(a.sinceId); return fixtureSearch(fixture)() }, store: store2, date: '2026-11-18', mode: 'dry-run' })
  assert.deepEqual(sent.sort(), ['1004', '2002'].sort())
})

test('a failed sheet write leaves since_id and state untouched, and the run still records its cost', async () => {
  const store = memoryStore()
  let saved = false
  store.appendRows = async () => { throw new Error('sheet down') }
  store.saveState = async () => { saved = true }
  const origLog = console.log; console.log = () => {}
  const r = await runJob({ cfg: baseCfg(), search: fixtureSearch(fixture), store, date: '2026-11-17', mode: 'live' })
  console.log = origLog
  assert.equal(saved, false)
  assert.equal(r.stop, 'error')
  assert.equal(store.runs.length, 1)
})

test('Google store: RAW only, hidden _state tab, _runs tab, no formulas ever submitted as USER_ENTERED', async () => {
  const calls = []
  const origFetch = globalThis.fetch
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sa = { client_email: 'sa@example.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ url: u, method: init.method ?? 'GET', body: init.body })
    const json = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'g' })
    if (u.includes('fields=sheets.properties')) return json({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] })
    if (u.includes('/values/') && (init.method ?? 'GET') === 'GET') return json({ values: [] })
    return json({})
  }
  try {
    const store = await googleStore({ sa, sheetId: 'abcdefghijklmnopqrstuvwxyz' })
    await store.appendRows('2026-11-17', [['h', 'l', "'=1", 'd', 'q']])
    await store.saveState({ since: new Map([['k', '5']]), seen: new Map([['1', '2026-11-17']]) })
    await store.appendRun(['t'])
  } finally { globalThis.fetch = origFetch }
  const all = calls.filter(c => !c.url.includes('oauth2'))
  assert.ok(all.some(c => c.body?.includes('"hidden":true')), 'state tab is created hidden')
  assert.ok(all.some(c => decodeURIComponent(c.url).includes("'_runs'")))
  assert.ok(!all.some(c => /USER_ENTERED/.test(c.url)))
  for (const c of all.filter(c => /\/values\/.*(PUT|POST)/.test(c.method + c.url) && !c.url.includes(':clear'))) assert.match(c.url, /valueInputOption=RAW/)
  assert.ok(all.every(c => c.url.startsWith('https://sheets.googleapis.com/')))
})

// ── Req 5: cost caps ─────────────────────────────────────────────────────────

test('prices: $0.005 per post, $0.010 per user', () => {
  assert.equal(estimateMicro(1000, 0), 5_000_000)
  assert.equal(estimateMicro(100, 50), 1_000_000)
})

test('planRequest sizes the worst case under both caps and stops below X\'s 10-post minimum', () => {
  const m = d => toMicro(d)
  assert.equal(planRequest({ perQuery: 50, dailyLeftMicro: m(3), monthLeftMicro: m(25) }), 50)
  assert.equal(planRequest({ perQuery: 50, dailyLeftMicro: m(0.30), monthLeftMicro: m(25) }), 20)
  assert.equal(planRequest({ perQuery: 50, dailyLeftMicro: m(3), monthLeftMicro: m(0.14) }), 0)
  assert.equal(planRequest({ perQuery: 50, dailyLeftMicro: -5, monthLeftMicro: m(25) }), 0)
})

test('the daily cap stops the run before it is exceeded', async () => {
  const store = memoryStore({ spend: { dayMicro: toMicro(2.9), monthMicro: toMicro(2.9) } })
  let calls = 0
  const origLog = console.log; console.log = () => {}
  const r = await runJob({ cfg: baseCfg(), search: async () => { calls++; return { data: [] } }, store, date: '2026-11-17', mode: 'live' })
  console.log = origLog
  assert.equal(calls, 0)
  assert.equal(r.stop, 'daily cap')
})

test('the monthly cap stops the run, and a run never plans past the remaining dollars', async () => {
  const store = memoryStore({ spend: { dayMicro: 0, monthMicro: toMicro(24.5) } })
  const asked = []
  const origLog = console.log; console.log = () => {}
  const r = await runJob({ cfg: baseCfg(), search: async a => { asked.push(a.maxResults); return { data: [] } }, store, date: '2026-11-17', mode: 'live' })
  console.log = origLog
  assert.ok(asked.every(n => n * 15_000 <= toMicro(0.5)))
  assert.ok(asked.length > 0 || r.stop === 'monthly cap')
})

test('every run logs reads, users, dollars and month-to-date, and writes a _runs row', async () => {
  const store = memoryStore({ spend: { dayMicro: toMicro(1), monthMicro: toMicro(4) } })
  const lines = []
  const origLog = console.log; console.log = l => lines.push(l)
  await runJob({ cfg: baseCfg(), search: fixtureSearch(fixture), store, date: '2026-11-17', mode: 'dry-run' })
  console.log = origLog
  const s = JSON.parse(lines.at(-1))
  assert.equal(s.postReads, 7)
  assert.equal(s.userReads, 7)
  assert.equal(s.estUsd, 0.105)
  assert.equal(s.monthToDateUsd, 4.105)
  assert.equal(store.runs.length, 1)
  assert.equal(store.runs[0][6], 0.105)
})

// ── Req 6: dry run makes no network call ─────────────────────────────────────

test('dry run runs end to end with fetch disabled and no secrets', () => {
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'fixtures/no-network.mjs'), path.join(here, 'x-search.mjs')],
    { env: { PATH: process.env.PATH, DRY_RUN: 'true', X_SEARCH_DATE: '2026-11-17' }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /DRY RUN \(fixture, no X call, nothing written\)/)
  assert.match(r.stdout, /"event":"run"/)
})

test('a live run without its secrets fails before any X request, naming them without values', () => {
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'fixtures/no-network.mjs'), path.join(here, 'x-search.mjs')],
    { env: { PATH: process.env.PATH, X_BEARER_TOKEN: 'abc' }, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /GOOGLE_SERVICE_ACCOUNT_JSON/)
  assert.doesNotMatch(r.stderr + r.stdout, /abc/)
  assert.throws(() => requireSecrets({}), /X_BEARER_TOKEN/)
})

test('the workflow is a dry run unless explicitly made live, and the first manual live run is 1 query / 10 posts', () => {
  const wf = read('.github/workflows/x-search.yml')
  assert.match(wf, /cron: '30 13 \* \* \*'/)
  assert.match(wf, /workflow_dispatch/)
  assert.match(wf, /vars\.X_SEARCH_ENABLED == 'true'\)\) && 'false' \|\| 'true'/)
  assert.match(wf, /dry_run:[\s\S]*?default: true/)
  assert.match(wf, /max_queries:[\s\S]*?default: '1'/)
  assert.match(wf, /max_posts_per_query:[\s\S]*?default: '10'/)
})

// ── Retention: post text must not outlive about a day ───────────────────────

const H = 3600_000
const NOW = Date.parse('2026-11-19T13:30:00Z')
const iso = hoursAgo => new Date(NOW - hoursAgo * H).toISOString()
const OTHER = ['_state', '_runs', 'Leads', 'Sheet1', '2026-11-01']  // 2026-11-01 matches the name pattern but the job did not create it
const RECORDS = new Map([['2026-11-17', iso(48)], ['2026-11-18', iso(23.9)], ['2026-11-19', iso(1)]])

test('expiredTabs: recorded tabs at least 20h old go; younger ones stay', () => {
  assert.deepEqual(expiredTabs(RECORDS, NOW).sort(), ['2026-11-17', '2026-11-18'])
  assert.deepEqual(expiredTabs(new Map([['2026-11-18', iso(19.9)]]), NOW), [])
  assert.deepEqual(expiredTabs(new Map([['2026-11-18', iso(20)]]), NOW), ['2026-11-18'])
})

test('expiredTabs never returns a tab the job did not record, or a non-date name even if recorded', () => {
  assert.deepEqual(expiredTabs(new Map(), NOW), [])
  assert.deepEqual(expiredTabs(new Map([['Leads', iso(99)], ['_state', iso(99)], ['_runs', iso(99)], ['2026-11-10 copy', iso(99)], ['2026-11-18', 'garbage']]), NOW), [])
})

const runAt = (store, mode, now = new Date(NOW)) => {
  const lines = []; const orig = console.log; console.log = l => lines.push(l)
  return runJob({ cfg: baseCfg(), search: fixtureSearch(fixture), store, date: '2026-11-19', mode, now: () => now }).finally(() => { console.log = orig }).then(r => ({ r, last: JSON.parse(lines.at(-1)) }))
}

test('a live run deletes the old recorded tabs after writing; Leads, _state, _runs and unrecorded tabs are never touched', async () => {
  const store = memoryStore({ existingTabs: [...OTHER, ...RECORDS.keys()], tabRecords: RECORDS })
  const { last } = await runAt(store, 'live')
  assert.deepEqual(store.deletedTabs.sort(), ['2026-11-17', '2026-11-18'])
  for (const t of [...OTHER, '2026-11-19']) assert.ok(store.tabs.has(t), t)
  assert.deepEqual(last.tabsDeleted.sort(), ['2026-11-17', '2026-11-18'])
  // the records of deleted tabs are dropped; today's tab (first write now) is recorded
  assert.deepEqual([...store.state.tabs.keys()].sort(), ['2026-11-19'])
})

test('a brand-new day tab is recorded with its first-write time and not deleted by the run that wrote it', async () => {
  const store = memoryStore()
  await runAt(store, 'live')
  assert.equal(store.state.tabs.get('2026-11-19'), new Date(NOW).toISOString())
  assert.deepEqual(store.deletedTabs, [])
})

test('a dry run deletes nothing and logs what it would delete', async () => {
  const store = memoryStore({ existingTabs: [...OTHER, ...RECORDS.keys()], tabRecords: RECORDS })
  const { last } = await runAt(store, 'dry-run')
  assert.deepEqual(store.deletedTabs, [])
  for (const t of [...OTHER, ...RECORDS.keys()]) assert.ok(store.tabs.has(t), t)
  assert.deepEqual(last.tabsWouldDelete.sort(), ['2026-11-17', '2026-11-18'])
  assert.deepEqual(last.tabsDeleted, [])
})

test('retention does not run when the write failed', async () => {
  const store = memoryStore({ existingTabs: [...RECORDS.keys()], tabRecords: RECORDS })
  store.appendRows = async () => { throw new Error('sheet down') }
  await runAt(store, 'live')
  assert.deepEqual(store.deletedTabs, [])
})

test('Google store: tab records round-trip through _state, and deleting sends deleteSheet only for day-named tabs asked for', async () => {
  const calls = []
  const origFetch = globalThis.fetch
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sa = { client_email: 'sa@example.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  const sheets = [['_state', 1], ['_runs', 2], ['Leads', 3], ['2026-11-17', 4], ['2026-11-19', 5]].map(([title, sheetId]) => ({ properties: { sheetId, title, hidden: title === '_state' } }))
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ url: u, method: init.method ?? 'GET', body: init.body })
    const json = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'g' })
    if (u.includes('fields=sheets.properties')) return json({ sheets })
    if (u.includes('_state') && u.includes('/values/') && (init.method ?? 'GET') === 'GET') return json({ values: [['tab', '2026-11-17', iso(30)]] })
    return json({})
  }
  try {
    const store = await googleStore({ sa, sheetId: 'abcdefghijklmnopqrstuvwxyz' })
    const st = await store.loadState()
    assert.deepEqual([...st.tabs], [['2026-11-17', iso(30)]])
    await store.saveState({ since: new Map(), seen: new Map(), tabs: st.tabs })
    await store.deleteTabs(['2026-11-17', '_state', 'Leads'])  // the guard drops the two that are not day tabs
  } finally { globalThis.fetch = origFetch }
  const del = calls.filter(c => String(c.body ?? '').includes('deleteSheet'))
  assert.equal(del.length, 1)
  assert.deepEqual(JSON.parse(del[0].body).requests, [{ deleteSheet: { sheetId: 4 } }])
  assert.ok(calls.some(c => String(c.body ?? '').includes('"tab"') && c.url.includes('valueInputOption=RAW')))
  assert.ok(calls.every(c => c.url.startsWith('https://sheets.googleapis.com/') || c.url.includes('oauth2.googleapis.com')))
})

test('SAFETY: the X request asks for no location or profile fields beyond what the five columns need', () => {
  const src = read('scripts/x-search-client.mjs')
  assert.match(src, /'tweet\.fields': 'created_at,author_id,referenced_tweets'/)
  assert.match(src, /'user\.fields': 'username'/)
  assert.match(src, /expansions: 'author_id'/)
  assert.doesNotMatch(src, /geo|place|location|public_metrics|description|entities|profile/i)
})
