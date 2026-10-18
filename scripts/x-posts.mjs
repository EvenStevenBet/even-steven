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
//   STATE_FILE, CONFIG_FILE       default data/x-posts-state.json, data/x-posts-config.json
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
const Z_SCALE = 10_000n
const MAX_LEN = 280
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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

/** "Packers -3.5", "Cowboys -1", or "pick'em". Home is quoted at -Z (Z > 0 means home lays points). */
export function lineText(z, home, away) {
  const n = floorLine(z)
  if (n === 0) return "pick'em"
  const team = n > 0 ? home : away
  const by = Math.abs(n)
  return `${team} -${Number.isInteger(by) ? by : by.toFixed(1)}`
}

/** "Packers won by 7", "Cowboys won by 3", "Packers and Cowboys tied". finalSpread = home − away. */
export function resultText(finalSpread, home, away) {
  const n = Number(finalSpread)
  if (n === 0) return `${home} and ${away} tied`
  return `${n > 0 ? home : away} won by ${Math.abs(n)}`
}

function whole(usdcRaw) { return `$${(usdcRaw / 1_000_000n).toLocaleString('en-US')}` }

/**
 * The three templates. `m` is chain data: { gameId, initialZ, currentZ, stakes (USDC raw, seed excluded),
 * finalSpread }. Returns the text, or throws if the gameId is unusable or the text breaks a rule.
 */
export function render(event, m) {
  const g = parseGameId(m.gameId)
  if (!g) throw new Error(`gameId does not parse: ${m.gameId}`)
  if (!SAFE_NAME.test(g.home) || !SAFE_NAME.test(g.away)) throw new Error(`unsafe team name in ${m.gameId}`)
  const where = `${g.away} at ${g.home}`
  const when = `${g.sport}, ${MONTHS[g.month - 1]} ${g.day}${g.game ? `, game ${g.game}` : ''}`
  let text
  if (event === 'opened') {
    text = [`Market open: ${where} (${when}).`,
            `Line: ${lineText(m.initialZ, g.home, g.away)}.`,
            'Winners split the pool. One flat 2% fee on stake.'].join('\n')
  } else if (event === 'closed') {
    text = [`Betting closed: ${where} (${when}).`,
            `Closing line: ${lineText(m.currentZ, g.home, g.away)}.`,
            m.stakes > 0n ? `Stakes in the pool: ${whole(m.stakes)}.` : 'No bets were placed.'].join('\n')
  } else if (event === 'settled') {
    text = [`Final: ${resultText(m.finalSpread, g.home, g.away)} (${where}, ${when}).`,
            'Winners can claim their payouts now.'].join('\n')
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

/** Pure. Markets older than config.notBefore (a YYYY-MM-DD compared with the gameId's date) are ignored. */
export function eligible(gameId, config) {
  const g = parseGameId(gameId)
  return !!g && g.date >= config.notBefore
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
    if (!eligible(m.gameId, cfg.config)) continue
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

async function chainMarkets(rpcUrl, factory, limit = 25) {
  const { createPublicClient, http, parseAbi } = await import('viem')
  const { base } = await import('viem/chains')
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 60_000 }) })
  const abi = parseAbi([
    'function getAllMarkets() view returns (address[])',
    'function gameId() view returns (string)', 'function bettingOpen() view returns (bool)',
    'function settled() view returns (bool)', 'function canceled() view returns (bool)',
    'function refundMode() view returns (bool)', 'function initialZ() view returns (int256)',
    'function currentZ() view returns (int256)', 'function totalPool() view returns (uint256)',
    'function protocolSeedTotal() view returns (uint256)', 'function finalSpread() view returns (int256)',
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
      const [initialZ, currentZ, totalPool, seed] = await Promise.all(['initialZ', 'currentZ', 'totalPool', 'protocolSeedTotal'].map(r))
      Object.assign(m, { initialZ, currentZ, stakes: totalPool - seed })
      if (stage === 'settled') m.finalSpread = await r('finalSpread')
    }
    out.push(m)
  }
  return out
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const stateFile = process.env.STATE_FILE || path.join(root, 'data/x-posts-state.json')
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || path.join(root, 'data/x-posts-config.json'), 'utf8'))
  const cfg = {
    enabled: process.env.X_POSTS_ENABLED === 'true',
    dryRun: process.env.DRY_RUN !== 'false',
    maxPosts: Number(process.env.X_MAX_POSTS_PER_RUN || 3),
    config,
  }
  if (!process.env.RPC_URL) throw new Error('RPC_URL is not set')
  const state = loadState(stateFile)
  const live = cfg.enabled && !cfg.dryRun
  log('start', { mode: live ? 'LIVE' : 'dry-run', X_POSTS_ENABLED: cfg.enabled, DRY_RUN: cfg.dryRun })

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
    markets: () => chainMarkets(process.env.RPC_URL, process.env.FACTORY_ADDRESS || V1_6_FACTORY),
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
