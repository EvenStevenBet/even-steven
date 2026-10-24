// X market posts — three events per market, written from fixed templates and chain data. No model.
//
//   opened  a market exists and betting is open
//   closed  betting is closed (closeBetting at kickoff)
//   settled the oracle settled it and it is not a refund/cancel
//
// Nothing here follows, replies, likes, reposts, mentions or links. Posts are plain text.
// State (data/x-posts-state.json) records every event already posted, so a rerun never posts twice.
//
// Env:
//   RPC_URL                       Base mainnet RPC (same secret the other workflows use)
//   FACTORY_ADDRESS               default SportsbookFactory v1.6
//   X_POSTS_ENABLED               must be exactly "true" to post at all (default false)
//   DRY_RUN                       must be exactly "false" to post (default true); a dry run logs the
//                                 posts it would make and never writes state
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET   posting app, OAuth 1.0a user context
//   X_MAX_POSTS_PER_RUN           safety cap per run (default 3)
//   X_POSTS_NOT_BEFORE            repo variable: an ISO 8601 time (or a UTC date, YYYY-MM-DD). Any event whose own on-chain
//                                 time is earlier is skipped: opened = the market's creation block, closed = bettingClosedAt,
//                                 settled = settledAt. REQUIRED in live mode (the run fails with an error if it is unset);
//                                 optional in a dry run, where unset means no filter.
//   STATE_FILE                    default data/x-posts-state.json
//
// Any failed post (warning, restriction, rate limit, auth, outage, timeout) disables posting in the
// state file, records the reason, and fails the run. There is no retry: a human clears `disabled`.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const V1_6_FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
export const EVENTS = ['opened', 'closed', 'settled']
const RANK = { opened: 0, closed: 1, settled: 2 }
// Jeff's approved even-money sentence (ES - Context, value order 1), word for word. The only place a post may say
// "$100 wins $100"; tests pin it. Sentence 2 of the pitch (early line edge) is deliberately not used.
export const EVEN_MONEY = 'Back either side at even money. The spread moves to balance the pool, so $100 wins $100.'
const Z_SCALE = 10_000n
const MAX_LEN = 280

// ── Pure: parsing and wording ────────────────────────────────────────────────

/** gameId "SPORT-YYYY-MM-DD-HOME-<home>-AWAY-<away>[-G1]" → fields, or null if it does not match. */
export function parseGameId(gameId) {
  const m = /^([A-Z0-9]+)-(\d{4})-(\d{2})-(\d{2})-HOME-(.+?)-AWAY-(.+?)(?:-G([12]))?$/.exec(gameId)
  if (!m) return null
  const [, sport, y, mo, d, home, away, game] = m
  return { sport, date: `${y}-${mo}-${d}`, month: Number(mo), day: Number(d),
           home: home.replace(/-/g, ' '), away: away.replace(/-/g, ' '), game: game ? Number(game) : null }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .'&]*$/

function floorLine(z) { // Z is 4-decimal fixed point; returns the line as a number rounded to a tenth
  return Math.round((Number(z) / Number(Z_SCALE)) * 10) / 10
}

/** "Packers by 3.5", or "pick'em". Home is quoted at -Z (Z > 0 means home lays points). */
export function byText(z, home, away) {
  const n = floorLine(z)
  if (n === 0) return "pick'em"
  const by = Math.abs(n)
  return `${n > 0 ? home : away} by ${Number.isInteger(by) ? by : by.toFixed(1)}`
}

/** "Packers won by 7", "Cowboys won by 3", "Packers and Cowboys tied". finalSpread = home − away. */
export function resultText(finalSpread, home, away) {
  const n = Number(finalSpread)
  if (n === 0) return `${home} and ${away} tied`
  return `${n > 0 ? home : away} won by ${Math.abs(n)}`
}

/**
 * The three templates. `m` is chain data: { gameId, initialZ, currentZ, finalSpread }. Returns the text, or throws if the gameId is unusable or the text breaks a rule.
 */
export function render(event, m) {
  const g = parseGameId(m.gameId)
  if (!g) throw new Error(`gameId does not parse: ${m.gameId}`)
  if (!SAFE_NAME.test(g.home) || !SAFE_NAME.test(g.away)) throw new Error(`unsafe team name in ${m.gameId}`)
  // A doubleheader would otherwise post identical text twice, and X rejects a duplicate as an error.
  const where = `${g.away} at ${g.home}${g.game ? `, game ${g.game}` : ''}`
  let text
  if (event === 'opened') {
    text = `${where} is open. Line: ${byText(m.initialZ, g.home, g.away)}. ${EVEN_MONEY}`
  } else if (event === 'closed') {
    text = `Betting is closed on ${where}. Line closed at ${byText(m.currentZ, g.home, g.away)}.`
  } else if (event === 'settled') {
    text = `Final: ${resultText(m.finalSpread, g.home, g.away)}. Winners split the pool.`
  } else throw new Error(`unknown event ${event}`)
  assertPostable(text)
  return text
}

/** Hard rules on every post: short, plain text, no link, no mention, no hashtag. */
export function assertPostable(text) {
  if (text.length > MAX_LEN) throw new Error(`post is ${text.length} chars`)
  if (/[@#]/.test(text)) throw new Error('post contains @ or #')
  if (/https?:|www\.|\.[a-z]{2,}(\/|\b)/i.test(text.replace(/\d+\.\d+/g, ''))) throw new Error('post contains a link or domain')
}

// ── Pure: which events to post ───────────────────────────────────────────────

/** Chain flags → the stage a market has reached, or null when it must never be posted (cancel/refund). */
export function stageOf({ bettingOpen, settled, canceled, refundMode }) {
  if (canceled || refundMode) return null
  if (settled) return 'settled'
  return bettingOpen ? 'opened' : 'closed'
}

/**
 * Pure. For one market: the single event to post now, and the earlier events to mark skipped.
 * Only the latest stage reached is ever posted — if the job was down across a kickoff, "betting closed"
 * goes out, not a stale "market open" followed by it. `posted` is state.markets[address] ({event: record}).
 */
export function pendingFor(stage, posted = {}) {
  if (stage === null) return { post: null, skip: [] }
  const reached = EVENTS.filter(e => RANK[e] <= RANK[stage])
  const todo = reached.filter(e => !posted[e])
  if (todo.length === 0) return { post: null, skip: [] }
  const post = todo[todo.length - 1]
  return { post: post === stage ? post : null, skip: todo.filter(e => e !== post) }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** Pure. X_POSTS_NOT_BEFORE as epoch seconds. A bare date is midnight UTC. Anything else is an error, never guessed. */
export function parseNotBefore(raw) {
  const v = String(raw ?? '').trim()
  if (!ISO.test(v) && !DATE_ONLY.test(v)) {
    throw new Error(`X_POSTS_NOT_BEFORE must be an ISO 8601 time with Z or an offset (2026-10-26T00:00:00Z) or a UTC date (2026-10-26), got "${v}"`)
  }
  const ms = Date.parse(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v)
  if (Number.isNaN(ms)) throw new Error(`X_POSTS_NOT_BEFORE is not a real date: "${v}"`)
  return Math.floor(ms / 1000)
}

/** Pure. Live mode refuses to start without it. Returns epoch seconds, or null (dry run only) for "no filter". */
export function requireNotBefore(raw, { live }) {
  const unset = raw === undefined || raw === null || String(raw).trim() === ''
  if (unset) {
    if (live) throw new Error('X_POSTS_NOT_BEFORE is not set. Live posting needs this repository variable (a time such as 2026-10-26T00:00:00Z): events before it are never posted. Set it to the go-live time, or run a dry run.')
    return null
  }
  return parseNotBefore(raw)
}

/**
 * The block timestamp of a contract's creation, found by binary search over eth_getCode. A market stores no open time, and
 * the factory creates and opens it in one transaction, so this is when it opened. Returns null when it cannot be proven
 * (an RPC without historical state throws), and the caller then skips the market rather than guess.
 */
export async function creationTimestamp(pub, address) {
  try {
    const hasCode = async (n) => { const c = await pub.getCode({ address, blockNumber: n }); return !!c && c !== '0x' }
    const latest = await pub.getBlockNumber()
    if (!(await hasCode(latest))) return null
    let lo = 0n, hi = latest // no code at block 0; code at `latest`
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await hasCode(mid)) hi = mid; else lo = mid }
    return Number((await pub.getBlock({ blockNumber: hi })).timestamp)
  } catch { return null }
}

// ── OAuth 1.0a (user context) and the post call ──────────────────────────────

const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export function oauthHeader(method, url, creds, { nonce = crypto.randomBytes(16).toString('hex'),
                                                   timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const params = { oauth_consumer_key: creds.apiKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
                   oauth_timestamp: timestamp, oauth_token: creds.accessToken, oauth_version: '1.0' }
  const norm = Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join('&')
  const base = [method.toUpperCase(), enc(url), enc(norm)].join('&')
  const key = `${enc(creds.apiSecret)}&${enc(creds.accessTokenSecret)}`
  params.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64')
  return 'OAuth ' + Object.keys(params).sort().map(k => `${enc(k)}="${enc(params[k])}"`).join(', ')
}

const X_URL = 'https://api.x.com/2/tweets'

/** One attempt, no retry. Returns { ok, status, id, detail }; never throws on an HTTP error. */
export async function postToX(text, creds, fetchFn = fetch) {
  let res
  try {
    res = await fetchFn(X_URL, {
      method: 'POST',
      headers: { Authorization: oauthHeader('POST', X_URL, creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return { ok: false, status: 0, id: null, detail: `no response (${err.name}): it may or may not have posted` }
  }
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (res.ok) return { ok: true, status: res.status, id: body?.data?.id ?? null, detail: '' }
  const detail = [body?.title, body?.detail, body?.type].filter(Boolean).join(' | ') || res.statusText
  return { ok: false, status: res.status, id: null, detail }
}

// ── State ────────────────────────────────────────────────────────────────────

export function emptyState() { return { disabled: null, markets: {} } }

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return emptyState()
    throw e
  }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(file + '.tmp', file)
}

// ── Run ──────────────────────────────────────────────────────────────────────

/**
 * One pass. io: { markets() → [{address, gameId, stage, ...chain}], post(text) → result, save(state), log }.
 * Returns { posted, skipped, wouldPost, halted }.
 */
export async function runOnce(state, io, cfg) {
  const out = { posted: [], skipped: [], wouldPost: [], halted: null }
  const live = cfg.enabled && !cfg.dryRun
  if (live && state.disabled) {
    out.halted = `posting is disabled in state since ${state.disabled.at}: ${state.disabled.reason}`
    return out
  }
  for (const m of await io.markets()) {
    if (m.stage === null) continue // cancelled or refund: never posts, so no event time is needed
    if (cfg.notBeforeSec != null) {
      // Events earlier than the cutoff never post. An event time that cannot be proven is treated as too early.
      if (m.eventAt == null) { io.log('skipped_event_time_unknown', { market: m.address, gameId: m.gameId, stage: m.stage }); continue }
      if (m.eventAt < cfg.notBeforeSec) continue
    }
    const posted = state.markets[m.address] ?? {}
    const { post, skip } = pendingFor(m.stage, posted)
    if (live) for (const e of skip) {
      state.markets[m.address] = { ...(state.markets[m.address] ?? {}), [e]: { skipped: 'superseded', at: io.now() } }
      out.skipped.push({ market: m.address, event: e })
    }
    if (!post) continue
    const text = render(post, m)
    if (!live) { out.wouldPost.push({ market: m.address, gameId: m.gameId, event: post, text }); continue }
    if (out.posted.length >= cfg.maxPosts) { io.log('post_cap_reached', { max: cfg.maxPosts }); break }

    const r = await io.post(text)
    if (!r.ok) {
      // Unknown whether a timeout/5xx posted, so record the attempt: this event is never re-posted by a machine.
      state.markets[m.address] = { ...(state.markets[m.address] ?? {}), [post]: { failed: r.status, at: io.now() } }
      state.disabled = { at: io.now(), reason: `X answered ${r.status || 'nothing'} posting ${post} for ${m.gameId}: ${r.detail}` }
      io.save(state)
      out.halted = state.disabled.reason
      return out
    }
    state.markets[m.address] = { ...(state.markets[m.address] ?? {}), [post]: { id: r.id, at: io.now() } }
    io.save(state) // before the next post, so a crash cannot forget this one
    out.posted.push({ market: m.address, event: post, id: r.id })
  }
  if (live && out.skipped.length) io.save(state)
  return out
}

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))

async function chainMarkets(rpcUrl, factory, { limit = 25, needEventTime = false } = {}) {
  const { createPublicClient, http, parseAbi } = await import('viem')
  const { base } = await import('viem/chains')
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 60_000 }) })
  const abi = parseAbi([
    'function getAllMarkets() view returns (address[])',
    'function gameId() view returns (string)', 'function bettingOpen() view returns (bool)',
    'function settled() view returns (bool)', 'function canceled() view returns (bool)',
    'function refundMode() view returns (bool)', 'function initialZ() view returns (int256)',
    'function currentZ() view returns (int256)', 'function finalSpread() view returns (int256)',
    'function bettingClosedAt() view returns (uint256)', 'function settledAt() view returns (uint256)',
  ])
  const all = await pub.readContract({ address: factory, abi, functionName: 'getAllMarkets' })
  const out = []
  for (const address of all.slice(-limit)) {
    const r = functionName => pub.readContract({ address, abi, functionName })
    const [gameId, bettingOpen, settled, canceled, refundMode] =
      await Promise.all(['gameId', 'bettingOpen', 'settled', 'canceled', 'refundMode'].map(r))
    const stage = stageOf({ bettingOpen, settled, canceled, refundMode })
    const m = { address, gameId, stage }
    if (stage !== null) {
      const [initialZ, currentZ] = await Promise.all(['initialZ', 'currentZ'].map(r))
      Object.assign(m, { initialZ, currentZ })
      if (stage === 'settled') m.finalSpread = await r('finalSpread')
      if (needEventTime) {
        // The time of the event this stage would post about, from the chain itself.
        if (stage === 'settled') m.eventAt = Number(await r('settledAt'))
        else if (stage === 'closed') m.eventAt = Number(await r('bettingClosedAt'))
        else m.eventAt = await creationTimestamp(pub, address)
      }
    }
    out.push(m)
  }
  return out
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const stateFile = process.env.STATE_FILE || path.join(root, 'data/x-posts-state.json')
  const enabled = process.env.X_POSTS_ENABLED === 'true', dryRun = process.env.DRY_RUN !== 'false'
  const live = enabled && !dryRun
  // Checked first, before any network call: a live run without a cutoff must not start.
  const notBeforeSec = requireNotBefore(process.env.X_POSTS_NOT_BEFORE, { live })
  const cfg = { enabled, dryRun, maxPosts: Number(process.env.X_MAX_POSTS_PER_RUN || 3), notBeforeSec }
  if (!process.env.RPC_URL) throw new Error('RPC_URL is not set')
  const state = loadState(stateFile)
  log('start', { mode: live ? 'LIVE' : 'dry-run', X_POSTS_ENABLED: cfg.enabled, DRY_RUN: cfg.dryRun,
                 notBefore: notBeforeSec == null ? null : new Date(notBeforeSec * 1000).toISOString() })
  if (notBeforeSec == null) log('warning_no_cutoff', { detail: 'X_POSTS_NOT_BEFORE is unset: nothing is filtered by time in this dry run, and a live run would refuse to start' })

  let creds = null
  if (live) {
    const need = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']
    const missing = need.filter(k => !process.env[k])
    if (missing.length) throw new Error(`live mode needs ${missing.join(', ')}`)
    creds = { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET,
              accessToken: process.env.X_ACCESS_TOKEN, accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET }
  }
  const io = {
    now: () => new Date().toISOString(),
    log,
    markets: () => chainMarkets(process.env.RPC_URL, process.env.FACTORY_ADDRESS || V1_6_FACTORY, { needEventTime: notBeforeSec != null }),
    post: text => postToX(text, creds),
    save: s => saveState(stateFile, s),
  }
  const r = await runOnce(state, io, cfg)
  for (const w of r.wouldPost) {
    console.log(`\n--- ${live ? 'WOULD POST' : 'DRY RUN: would post'} [${w.event}] ${w.gameId} (${w.market}) ---\n${w.text}\n--- ${w.text.length} chars ---`)
  }
  if (!r.wouldPost.length && !r.posted.length && !r.halted) log('nothing_to_post')
  for (const p of r.posted) log('posted', p)
  if (r.halted) {
    console.error(`::error title=X posting disabled::${r.halted}`)
    log('halted', { reason: r.halted })
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`::error::${(err.shortMessage || err.message || '').split('\n')[0]}`); process.exit(1) })
}
