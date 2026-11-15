// Daily X lead search → Google Sheet "ES - X Search". READ-ONLY on X (see x-search-client.mjs).
//
// Post text is DATA. It is written to the sheet as plain text and nothing else: never sent to a model, agent or
// tool, never followed as an instruction, no link in it is opened. This file imports no model SDK and no process runner.
//
// Env (names only; Jeff sets the values):
//   X_BEARER_TOKEN                app-only Bearer Token (secret). Live runs only.
//   GOOGLE_SERVICE_ACCOUNT_JSON   service account key file contents (secret). Live runs only.
//   X_SEARCH_SHEET_ID             id of the "ES - X Search" spreadsheet (repository variable). Live runs only.
//   DRY_RUN=true                  run against scripts/fixtures/x-search-fixture.json: no X call, no Google call.
//   X_SEARCH_DAILY_CAP_USD / X_SEARCH_MONTHLY_CAP_USD   override the caps in the config file
//   X_SEARCH_MAX_QUERIES / X_SEARCH_MAX_POSTS_PER_QUERY  tighten a run (used for the first live run)
//   X_SEARCH_DATE                 override today's UTC date (YYYY-MM-DD)
//
// Cost: $0.005 per post read, $0.010 per user read (docs.x.com pricing). Each request is sized so that, even if every
// post brought a distinct user, the request cannot take the day or month past its cap. Spend is read from the "_runs" tab.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { xSearch } from './x-search-client.mjs'

export const COLUMNS = ['handle', 'post link', 'post text', 'date', 'query']
export const RUNS_COLUMNS = ['run at (UTC)', 'date', 'mode', 'queries run', 'post reads', 'user reads', 'est. USD', 'day total USD', 'month-to-date USD', 'stopped because']
export const STATE_TAB = '_state'
export const RUNS_TAB = '_runs'
export const MICRO = 1_000_000
export const PRICE_POST_MICRO = 5_000   // $0.005
export const PRICE_USER_MICRO = 10_000  // $0.010
const SEEN_DAYS = 8 // X recent search reaches back 7 days; older ids can never be returned again
const MAX_QUERIES = 25
const MAX_QUERY_LEN = 400   // the config text; the composed query must also fit X's 512-char limit
const MAX_COMPOSED_LEN = 512
const KNOWN_KEYS = new Set(['queries', 'excludeRetweets', 'lang', 'maxPostsPerQuery', 'dailyCapUsd', 'monthlyCapUsd'])

// ── Config ───────────────────────────────────────────────────────────────────

/** Pure. Throws on anything unexpected, so a bad edit to the reviewed config fails the run before any X request. */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config must be an object')
  for (const k of Object.keys(cfg)) if (!KNOWN_KEYS.has(k)) throw new Error(`config: unknown key "${k}"`)
  if (!Array.isArray(cfg.queries) || cfg.queries.length === 0) throw new Error('config: queries must be a non-empty array')
  if (cfg.queries.length > MAX_QUERIES) throw new Error(`config: at most ${MAX_QUERIES} queries (got ${cfg.queries.length})`)
  const seen = new Set()
  for (const q of cfg.queries) {
    if (typeof q !== 'string' || q.trim() === '') throw new Error('config: every query must be a non-empty string')
    if (q.length > MAX_QUERY_LEN) throw new Error(`config: a query is ${q.length} chars (max ${MAX_QUERY_LEN})`)
    if (/[\u0000-\u001F\u007F]/.test(q)) throw new Error('config: a query contains a control character')
    if (seen.has(q)) throw new Error('config: duplicate query')
    seen.add(q)
    if (buildQuery(q, cfg).length > MAX_COMPOSED_LEN) throw new Error(`config: a query is over ${MAX_COMPOSED_LEN} chars once operators are added`)
  }
  if (cfg.excludeRetweets !== undefined && typeof cfg.excludeRetweets !== 'boolean') throw new Error('config: excludeRetweets must be true or false')
  if (cfg.lang !== undefined && !/^[a-z]{2,3}$/.test(cfg.lang)) throw new Error('config: lang must be a 2-3 letter code')
  const mp = cfg.maxPostsPerQuery ?? 50
  if (!Number.isInteger(mp) || mp < 10 || mp > 100) throw new Error('config: maxPostsPerQuery must be an integer 10-100 (X minimum is 10)')
  for (const k of ['dailyCapUsd', 'monthlyCapUsd']) {
    if (!(typeof cfg[k] === 'number' && cfg[k] > 0 && cfg[k] <= 1000)) throw new Error(`config: ${k} must be a number above 0`)
  }
  return { ...cfg, excludeRetweets: cfg.excludeRetweets ?? true, maxPostsPerQuery: mp }
}

/** Pure. The query string sent to X: the reviewed text, grouped, with retweets excluded unless the config opts out. */
export function buildQuery(q, cfg) {
  let out = `(${q.trim()})`
  if (cfg.excludeRetweets !== false && !/-is:retweet/.test(q)) out += ' -is:retweet'
  if (cfg.lang && !/\blang:/.test(q)) out += ` lang:${cfg.lang}`
  return out
}

/** Pure. Env overrides on top of the config. Anything non-numeric is an error, never silently ignored. */
export function applyEnv(cfg, env) {
  const num = (name, min, max) => {
    const raw = env[name]
    if (raw === undefined || String(raw).trim() === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`)
    return n
  }
  const out = { ...cfg }
  out.dailyCapUsd = num('X_SEARCH_DAILY_CAP_USD', 0.01, 1000) ?? cfg.dailyCapUsd
  out.monthlyCapUsd = num('X_SEARCH_MONTHLY_CAP_USD', 0.01, 1000) ?? cfg.monthlyCapUsd
  out.maxPostsPerQuery = num('X_SEARCH_MAX_POSTS_PER_QUERY', 10, 100) ?? cfg.maxPostsPerQuery
  const mq = num('X_SEARCH_MAX_QUERIES', 1, MAX_QUERIES)
  if (mq !== undefined) out.queries = cfg.queries.slice(0, Math.floor(mq))
  return out
}

// ── Cell safety and rows ─────────────────────────────────────────────────────

/** Pure. Text for a RAW cell: control chars dropped; a leading = + - @ (also after spaces/tabs) gets a single quote in front. */
export function cell(value) {
  let s = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2000)
  if (/^[\t\r\n ]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`
  return s
}

/** Pure. X search response → { rows, newestId, posts, users }. Skips ids already seen; adds new ids to `seen`. */
export function processResponse(query, body, seen, { excludeRetweets = true } = {}) {
  const users = new Map((body.includes?.users ?? []).map(u => [u.id, u]))
  const rows = []
  for (const t of body.data ?? []) {
    if (!/^\d{1,20}$/.test(String(t.id))) continue
    if (excludeRetweets && (t.referenced_tweets ?? []).some(r => r.type === 'retweeted')) continue
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const username = users.get(t.author_id)?.username
    const handle = typeof username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : ''
    // The link is built from the numeric id and a validated handle, never copied from post text.
    const link = handle ? `https://x.com/${handle}/status/${t.id}` : `https://x.com/i/status/${t.id}`
    rows.push([cell(handle), link, cell(t.text), cell(t.created_at ?? ''), cell(query)])
  }
  return { rows, newestId: body.meta?.newest_id ? String(body.meta.newest_id) : null, posts: (body.data ?? []).length, users: (body.includes?.users ?? []).length }
}

const maxId = (a, b) => (a && b ? (BigInt(a) >= BigInt(b) ? a : b) : (a ?? b))

// ── Cost caps ────────────────────────────────────────────────────────────────

export const usd = micro => Math.round(micro) / MICRO
export const toMicro = dollars => Math.round(dollars * MICRO)

/**
 * Pure. How many posts to ask for next, or 0 to stop. Worst case every post brings a distinct user, so a request of n
 * posts can cost at most n × ($0.005 + $0.010). X's minimum page is 10; if even 10 would pass a cap, stop.
 */
export function planRequest({ perQuery, dailyLeftMicro, monthLeftMicro }) {
  const left = Math.min(dailyLeftMicro, monthLeftMicro)
  const n = Math.min(perQuery, Math.floor(left / (PRICE_POST_MICRO + PRICE_USER_MICRO)))
  return n >= 10 ? n : 0
}

export const estimateMicro = (posts, users) => posts * PRICE_POST_MICRO + users * PRICE_USER_MICRO

// ── The run (store and search are injected: tests and dry-run use no network) ──

/**
 * store: { loadState() → {since:Map, seen:Map}, loadSpend(date) → {dayMicro, monthMicro},
 *          appendRows(date, rows), saveState({since, seen}), appendRun(row) }
 * search: async ({query, maxResults, sinceId}) → X response body
 */
export async function runJob({ cfg, search, store, date, mode, now = () => new Date() }) {
  const { since, seen: seenDays } = await store.loadState()
  const { dayMicro: dayStart, monthMicro: monthStart } = await store.loadSpend(date)
  const dailyCap = toMicro(cfg.dailyCapUsd), monthlyCap = toMicro(cfg.monthlyCapUsd)
  const seen = new Set(seenDays.keys())
  const newSince = new Map(since)
  const rows = []
  let posts = 0, users = 0, queriesRun = 0, stop = 'done', error = null

  for (const q of cfg.queries) {
    const full = buildQuery(q, cfg)
    const key = crypto.createHash('sha1').update(full).digest('hex').slice(0, 12)
    const spent = estimateMicro(posts, users)
    const n = planRequest({ perQuery: cfg.maxPostsPerQuery, dailyLeftMicro: dailyCap - dayStart - spent, monthLeftMicro: monthlyCap - monthStart - spent })
    if (n === 0) { stop = (dailyCap - dayStart - spent) <= (monthlyCap - monthStart - spent) ? 'daily cap' : 'monthly cap'; break }
    let body
    try { body = await search({ query: full, maxResults: n, sinceId: since.get(key) }) } catch (err) { error = err; stop = 'error'; break }
    queriesRun++
    const r = processResponse(q, body, seen, cfg)
    rows.push(...r.rows)
    posts += r.posts; users += r.users
    // Over-run guard: X returned more than we asked for, or priced above plan. Record it and stop.
    if (r.posts > n) { stop = 'X returned more posts than requested'; error = new Error(stop); break }
    const nid = maxId(since.get(key), r.newestId)
    if (nid) newSince.set(key, nid)
  }

  const runMicro = estimateMicro(posts, users)
  const today = date
  let written = false
  try {
    if (rows.length > 0) await store.appendRows(date, rows)
    written = true
    // since_id and the seen list advance only after the rows are safely in the sheet.
    const keep = new Map()
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - SEEN_DAYS * 86400_000).toISOString().slice(0, 10)
    for (const [id, d] of seenDays) if (d >= cutoff) keep.set(id, d)
    for (const id of seen) if (!keep.has(id)) keep.set(id, today)
    await store.saveState({ since: newSince, seen: keep })
  } catch (err) { error = error ?? err; stop = 'error' }
  finally {
    // Always record what this run cost, even when it failed: that record is what the caps are enforced from.
    const dayTotal = dayStart + runMicro, monthTotal = monthStart + runMicro
    const summary = { event: 'run', mode, date, queriesRun, queriesConfigured: cfg.queries.length, postReads: posts, userReads: users,
      newRows: rows.length, rowsWritten: written ? rows.length : 0, estUsd: usd(runMicro), dayTotalUsd: usd(dayTotal), monthToDateUsd: usd(monthTotal),
      dailyCapUsd: cfg.dailyCapUsd, monthlyCapUsd: cfg.monthlyCapUsd, stoppedBecause: stop, error: error?.message ?? null }
    try { await store.appendRun([now().toISOString(), date, mode, queriesRun, posts, users, usd(runMicro), usd(dayTotal), usd(monthTotal), stop]) }
    catch (e) { summary.runsTabError = e.message }
    console.log(JSON.stringify(summary))
  }
  return { rows, posts, users, runMicro, stop, error }
}

// ── Dry-run store (memory only, no network) ──────────────────────────────────

export function memoryStore({ spend = { dayMicro: 0, monthMicro: 0 } } = {}) {
  const out = { tabs: new Map(), runs: [], state: null }
  return Object.assign(out, {
    async loadState() { return { since: new Map(), seen: new Map() } },
    async loadSpend() { return spend },
    async appendRows(date, rows) { out.tabs.set(date, [...(out.tabs.get(date) ?? []), ...rows]) },
    async saveState(s) { out.state = s },
    async appendRun(row) { out.runs.push(row) },
  })
}

export function fixtureSearch(fixture) {
  let i = 0
  return async () => fixture.responses[i++ % fixture.responses.length]
}

// ── Google Sheets store (service account, spreadsheets scope only) ───────────

const b64url = b => Buffer.from(b).toString('base64url')

export function serviceAccountJwt(sa, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }))
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key)
  return `${head}.${claim}.${b64url(sig)}`
}

async function googleFetch(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const text = await res.text()
  if (!res.ok) {
    let reason = text.slice(0, 200)
    try { const e = JSON.parse(text).error; reason = `${e.status ?? ''} ${e.message ?? ''}`.trim() } catch { /* raw */ }
    throw new Error(`Google ${res.status}: ${reason}`)
  }
  return text ? JSON.parse(text) : {}
}

async function accessToken(sa) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(sa) }),
  })
  if (!res.ok) throw new Error(`Google token request failed: ${res.status}`)
  return (await res.json()).access_token
}

export async function googleStore({ sa, sheetId }) {
  const token = await accessToken(sa)
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
  const rng = (tab, a1) => encodeURIComponent(`'${tab}'!${a1}`)
  // RAW everywhere: post text beginning with "=" can never become a formula.
  const put = (tab, a1, values) => googleFetch(`${base}/values/${rng(tab, a1)}?valueInputOption=RAW`, token, { method: 'PUT', body: JSON.stringify({ values }) })
  const append = (tab, values) => googleFetch(`${base}/values/${rng(tab, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, token, { method: 'POST', body: JSON.stringify({ values }) })
  const get = (tab, a1) => googleFetch(`${base}/values/${rng(tab, a1)}?valueRenderOption=UNFORMATTED_VALUE`, token)

  const meta = await googleFetch(`${base}?fields=sheets.properties(sheetId,title,hidden)`, token)
  const tabs = new Map(meta.sheets.map(s => [s.properties.title, s.properties]))
  async function ensureTab(title, { hidden = false, header } = {}) {
    const have = tabs.get(title)
    if (!have) {
      await googleFetch(`${base}:batchUpdate`, token, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title, hidden } } }] }) })
      tabs.set(title, { title, hidden })
      if (header) await put(title, 'A1', [header])
    } else if (hidden && !have.hidden) {
      await googleFetch(`${base}:batchUpdate`, token, { method: 'POST', body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: have.sheetId, hidden: true }, fields: 'hidden' } }] }) })
    }
  }
  await ensureTab(STATE_TAB, { hidden: true, header: ['kind', 'key', 'value'] })
  await ensureTab(RUNS_TAB, { header: RUNS_COLUMNS })

  return {
    async loadState() {
      const r = await get(STATE_TAB, 'A2:C')
      const since = new Map(), seen = new Map()
      for (const [kind, key, value] of r.values ?? []) {
        if (kind === 'since') since.set(String(key), String(value))
        else if (kind === 'seen') seen.set(String(key), String(value))
      }
      return { since, seen }
    },
    async loadSpend(date) {
      const r = await get(RUNS_TAB, 'A2:J')
      let dayMicro = 0, monthMicro = 0
      for (const row of r.values ?? []) {
        const d = String(row[1] ?? ''), est = Number(row[6])
        if (!Number.isFinite(est)) continue
        if (d.slice(0, 7) === date.slice(0, 7)) monthMicro += toMicro(est)
        if (d === date) dayMicro += toMicro(est)
      }
      return { dayMicro, monthMicro }
    },
    async appendRows(date, rows) {
      await ensureTab(date, { header: COLUMNS })
      await append(date, rows)
    },
    async saveState({ since, seen }) {
      const values = [...[...since].map(([k, v]) => ['since', k, v]), ...[...seen].map(([k, v]) => ['seen', k, v])]
      await googleFetch(`${base}/values/${rng(STATE_TAB, 'A2:C')}:clear`, token, { method: 'POST', body: '{}' })
      if (values.length) await put(STATE_TAB, 'A2', values)
    },
    async appendRun(row) { await append(RUNS_TAB, [row]) },
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Pure. Every secret a live run needs, checked before the first X request. Messages name secrets, never values. */
export function requireSecrets(env) {
  const blank = v => v === undefined || v === null || String(v).trim() === ''
  const missing = ['X_BEARER_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'X_SEARCH_SHEET_ID'].filter(k => blank(env[k]))
  if (missing.length) throw new Error(`missing required ${missing.join(', ')}. Nothing was requested from X.`)
  let sa
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Nothing was requested from X.') }
  if (typeof sa?.client_email !== 'string' || typeof sa?.private_key !== 'string') throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON has no client_email and private_key. Nothing was requested from X.')
  if (!/^[A-Za-z0-9_-]{20,}$/.test(env.X_SEARCH_SHEET_ID.trim())) throw new Error('X_SEARCH_SHEET_ID does not look like a sheet id. Nothing was requested from X.')
  return { token: env.X_BEARER_TOKEN.trim(), sa, sheetId: env.X_SEARCH_SHEET_ID.trim() }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const cfg = applyEnv(validateConfig(JSON.parse(fs.readFileSync(path.join(root, 'data/x-search-queries.json'), 'utf8'))), process.env)
  const dry = process.env.DRY_RUN === 'true'
  const date = process.env.X_SEARCH_DATE || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('X_SEARCH_DATE must be YYYY-MM-DD')

  let search, store
  if (dry) {
    search = fixtureSearch(JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/x-search-fixture.json'), 'utf8')))
    store = memoryStore()
  } else {
    const { token, sa, sheetId } = requireSecrets(process.env)
    store = await googleStore({ sa, sheetId })
    search = xSearch(token)
  }
  const r = await runJob({ cfg, search, store, date, mode: dry ? 'dry-run' : 'live' })
  if (dry) {
    console.log(`DRY RUN (fixture, no X call, nothing written): would append ${r.rows.length} rows to tab "${date}"`)
    for (const row of r.rows) console.log(JSON.stringify(row))
  }
  if (r.stop === 'daily cap' || r.stop === 'monthly cap') console.log(`::warning::stopped at the ${r.stop}`)
  if (r.error) throw r.error
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`::error::${(err.message || '').split('\n')[0]}`); process.exit(1) })
}
