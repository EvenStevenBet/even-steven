// Daily X search → Google Sheet. Read-only on X, write-only to one Drive folder.
//
// Runs each query in data/x-search-queries.json against X recent search (one page per query), stops at
// the run cap, and writes a Google Sheet "ES - X Search YYYY-MM-DD" into the Drive folder
// "Even Steven Growth" through a service account that only that folder is shared with.
//
// Env:
//   X_READ_BEARER_TOKEN            the read-only app's bearer token (GitHub secret)
//   GOOGLE_SERVICE_ACCOUNT_JSON    the service account's key file contents (GitHub secret)
//   DRY_RUN=true                   search and print the rows; write nothing to Drive
//   X_SEARCH_DATE                  override the sheet date (YYYY-MM-DD, default today UTC)
//
// No key, token or credential is ever put in a row, a sheet name or a log line.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const COLUMNS = ['query', 'post URL', 'author handle', 'author followers', 'post text', 'posted at', 'likes', 'reposts']
const SEARCH_URL = 'https://api.x.com/2/tweets/search/recent'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

export const SHEET_FILE_NAME = 'ES - X Search'

/** Pure. X search response → rows, minus ids already seen (a post matching two queries is listed once). */
export function toRows(query, body, seen = new Set()) {
  const users = new Map((body.includes?.users ?? []).map(u => [u.id, u]))
  const rows = []
  for (const t of body.data ?? []) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const u = users.get(t.author_id)
    const handle = u?.username ?? ''
    rows.push([query, handle ? `https://x.com/${handle}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
      handle, u?.public_metrics?.followers_count ?? '', t.text, t.created_at ?? '',
      t.public_metrics?.like_count ?? '', t.public_metrics?.retweet_count ?? ''])
  }
  return rows
}

/** Pure. How many posts to ask for next: the per-query share, never past the run cap. X's minimum is 10. */
export function nextBatch({ cap, have, perQuery }) {
  const left = cap - have
  if (left <= 0) return 0
  return Math.max(10, Math.min(100, perQuery, left))
}

/**
 * Pure-ish. Run every query, in order, until the cap. search(query, maxResults) → response body.
 * A failure keeps what was collected so far and is returned, so the caller can still write the rows.
 */
export async function collect(cfg, search) {
  const rows = [], seen = new Set()
  const perQuery = Math.floor(cfg.maxPostsPerRun / cfg.queries.length)
  let error = null
  for (const q of cfg.queries) {
    const n = nextBatch({ cap: cfg.maxPostsPerRun, have: rows.length, perQuery })
    if (n === 0) break
    let body
    try { body = await search(`${q} ${cfg.suffix ?? ''}`.trim(), n) } catch (err) { error = err; break }
    rows.push(...toRows(q, body, seen).slice(0, cfg.maxPostsPerRun - rows.length))
  }
  return { rows, error }
}

export function xSearch(token, fetchFn = fetch) {
  return async (query, maxResults) => {
    const u = new URL(SEARCH_URL)
    u.search = new URLSearchParams({
      query, max_results: String(maxResults), expansions: 'author_id',
      'tweet.fields': 'created_at,public_metrics,author_id', 'user.fields': 'username,public_metrics',
    })
    const res = await fetchFn(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      let detail = ''
      try { const b = await res.json(); detail = [b.title, b.detail].filter(Boolean).join(' | ') } catch { /* not JSON */ }
      throw new Error(`X search answered ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return res.json()
  }
}

// ── Google (service account → access token, Drive, Sheets) ───────────────────

const b64url = b => Buffer.from(b).toString('base64url')

export function serviceAccountJwt(sa, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }))
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key)
  return `${head}.${claim}.${b64url(sig)}`
}

async function googleFetch(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const text = await res.text()
  if (!res.ok) {
    // Google error bodies carry no credentials; keep the reason, drop the rest.
    let reason = text.slice(0, 300)
    try { const e = JSON.parse(text).error; reason = `${e.status ?? ''} ${e.message ?? ''} ${(e.errors ?? []).map(x => x.reason).join(',')}`.trim() } catch { /* raw */ }
    const err = new Error(`Google ${res.status}: ${reason}`)
    throw err
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

const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Adds one tab, named by date, to the existing spreadsheet SHEET_FILE_NAME inside the shared folder. The sheet is
 * created by a person (so it counts against their Drive, not the service account's); this never creates a file.
 * Re-running the same day clears and rewrites that day's tab.
 */
export async function writeTab({ sa, folderName, fileName, tab, rows }) {
  const token = await accessToken(sa)
  const find = async query => (await googleFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, token)).files
  const folders = await find(`name='${q(folderName)}' and mimeType='${FOLDER_MIME}' and trashed=false`)
  if (folders.length === 0) throw new Error(`Drive folder "${folderName}" not found: share it with ${sa.client_email} as Editor`)
  if (folders.length > 1) throw new Error(`more than one Drive folder named "${folderName}" is shared with the service account`)
  const files = await find(`name='${q(fileName)}' and mimeType='${SHEET_MIME}' and '${folders[0].id}' in parents and trashed=false`)
  if (files.length === 0) throw new Error(`spreadsheet "${fileName}" not found in "${folderName}": create it there first`)
  if (files.length > 1) throw new Error(`more than one spreadsheet named "${fileName}" in "${folderName}"`)
  const id = files[0].id
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`

  const meta = await googleFetch(`${base}?fields=sheets.properties.title`, token)
  if (!meta.sheets.some(s => s.properties.title === tab)) {
    await googleFetch(`${base}:batchUpdate`, token, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) })
  }
  const range = encodeURIComponent(`'${tab}'`)
  await googleFetch(`${base}/values/${range}:clear`, token, { method: 'POST', body: '{}' })
  // RAW, never USER_ENTERED: post text beginning with "=" must stay text, not become a formula.
  await googleFetch(`${base}/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, token,
    { method: 'PUT', body: JSON.stringify({ values: [COLUMNS, ...rows] }) })
  return id
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/x-search-queries.json'), 'utf8'))
  if (!Array.isArray(cfg.queries) || cfg.queries.length === 0) throw new Error('no queries in data/x-search-queries.json')
  const cap = Number(process.env.X_SEARCH_MAX_POSTS || cfg.maxPostsPerRun || 200)
  const dryRun = process.env.DRY_RUN === 'true'
  const date = process.env.X_SEARCH_DATE || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('X_SEARCH_DATE must be YYYY-MM-DD')
  if (!process.env.X_READ_BEARER_TOKEN) throw new Error('X_READ_BEARER_TOKEN is not set')

  const { rows, error } = await collect({ ...cfg, maxPostsPerRun: cap }, xSearch(process.env.X_READ_BEARER_TOKEN))
  console.log(JSON.stringify({ event: 'collected', posts: rows.length, cap, queries: cfg.queries.length, error: error?.message ?? null }))

  if (dryRun) {
    console.log(`DRY RUN: would write tab "${date}" of "${SHEET_FILE_NAME}" in "${cfg.driveFolderName}" with ${rows.length} rows`)
    for (const r of rows.slice(0, 10)) console.log(JSON.stringify(r))
  } else {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    const id = await writeTab({ sa, folderName: cfg.driveFolderName, fileName: SHEET_FILE_NAME, tab: date, rows })
    console.log(JSON.stringify({ event: 'written', sheet: SHEET_FILE_NAME, tab: date, id, rows: rows.length }))
  }
  if (error) throw error // rows collected before the failure were still written
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`::error::${(err.message || '').split('\n')[0]}`); process.exit(1) })
}
