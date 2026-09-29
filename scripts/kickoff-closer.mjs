// Kickoff closer — closes betting on every open market this wallet owns at its CSV gameDate,
// without anyone clicking. Runs as a long-lived GitHub Actions job (.github/workflows/
// kickoff-closer.yml): it re-reads the open markets every POLL_SECONDS, sleeps precisely until
// the next close is due, sends closeBetting(), marks the row closed in data/markets.csv, and
// before the 6-hour job limit hands off to a fresh run while any open market remains.
//
// closeBetting() is onlyOwner, so this needs the owner key — the same PRIVATE_KEY secret the
// market-opener bot already uses. It never runs anywhere else (never on Vercel, never beside
// the relay key).
//
// Env:
//   RPC_URL, PRIVATE_KEY, PRODUCTION_WALLET   same secrets as the market-opener bot
//   FACTORY_ADDRESS        default SportsbookFactory v1.6
//   CLOSE_LEAD_SECONDS     close this long before gameDate (default 60, so the tx is mined by kickoff)
//   POLL_SECONDS           how often to re-read open markets (default 30)
//   MAX_RUNTIME_SECONDS    hand off after this long (default 5h25m; the job limit is 6h)
//   DRY_RUN=true           one read-only pass: print the plan, simulate due closes, send nothing
//   GITHUB_TOKEN + GITHUB_REPOSITORY   read the CSV from, and write status=closed back to, main
//   MARKETS_CSV            local file or URL to read the CSV from instead (tests); disables write-back
//   FORK_IMPERSONATE=true  tests only: sign as PRODUCTION_WALLET through a Hardhat fork's
//                          impersonation (refused unless the RPC is a Hardhat node)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const V1_6_FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const factoryAbi = parseAbi(['function getOpenMarkets() view returns (address[])'])
const marketAbi = parseAbi([
  'function gameId() view returns (string)',
  'function owner() view returns (address)',
  'function bettingOpen() view returns (bool)',
  'function closeBetting()',
])

/** gameDate string → epoch ms, or null. Same strictness as the bot: no local-time guessing. */
export function parseGameDate(value) {
  if (typeof value !== 'string' || !ISO_STRICT.test(value)) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * Pure. markets: [{ address, gameId, gameDateMs | null }].
 * due: close now. next: the soonest future close. unknown: markets we can't time (never guessed).
 */
export function plan(markets, nowMs, leadSeconds) {
  const due = [], later = [], unknown = []
  for (const m of markets) {
    if (m.gameDateMs === null) { unknown.push(m); continue }
    const closeAtMs = m.gameDateMs - leadSeconds * 1000
    ;(closeAtMs <= nowMs ? due : later).push({ ...m, closeAtMs })
  }
  later.sort((a, b) => a.closeAtMs - b.closeAtMs)
  return { due, next: later[0] ?? null, unknown }
}

/**
 * Pure. Hand off once past maxRuntime, but not if a close is due within quietSeconds — a
 * fresh run takes ~1 minute to start, so the handoff waits until after that close.
 * hardCapSeconds forces the handoff regardless, still inside the job's timeout.
 */
export function shouldHandOff({ elapsedSeconds, nextCloseAtMs, nowMs, maxRuntimeSeconds, quietSeconds, hardCapSeconds }) {
  if (elapsedSeconds >= hardCapSeconds) return true
  if (elapsedSeconds < maxRuntimeSeconds) return false
  return nextCloseAtMs === null || nextCloseAtMs - nowMs > quietSeconds * 1000
}

/** Pure. Rows by gameId from the 11-column markets.csv (no quoted fields, same as the bot). */
export function parseCsv(text) {
  const rows = new Map()
  for (const line of text.split('\n').slice(1)) {
    const cols = line.replace(/\r$/, '').split(',')
    const gameId = (cols[0] ?? '').trim()
    if (gameId) rows.set(gameId, { gameDate: (cols[4] ?? '').trim(), status: (cols[5] ?? '').trim() })
  }
  return rows
}

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const int = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of seconds, got "${raw}"`)
  return Number(raw)
}

// ── CSV source and write-back ─────────────────────────────────────────────────
const GH = () => ({
  url: `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/data/markets.csv`,
  headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
})
const canWriteBack = () => !process.env.MARKETS_CSV && Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY)

async function readCsvText() {
  const src = process.env.MARKETS_CSV
  if (src) return /^https?:\/\//.test(src) ? (await fetch(src)).text() : fs.readFileSync(src, 'utf8')
  if (canWriteBack()) {
    const res = await fetch(`${GH().url}?ref=main`, { headers: GH().headers })
    if (!res.ok) throw new Error(`GitHub contents GET ${res.status}`)
    return Buffer.from((await res.json()).content, 'base64').toString('utf8')
  }
  const res = await fetch('https://raw.githubusercontent.com/EvenStevenBet/even-steven/main/data/markets.csv')
  if (!res.ok) throw new Error(`markets.csv fetch ${res.status}`)
  return res.text()
}

/** status open → closed on the gameId's row, same commit message as the bot. Retries on a stale sha. */
async function markClosed(gameId) {
  if (!canWriteBack()) return log('csv_write_skipped', { gameId, reason: 'no GITHUB_TOKEN/GITHUB_REPOSITORY, or MARKETS_CSV override' })
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${GH().url}?ref=main`, { headers: GH().headers })
    if (!res.ok) throw new Error(`GitHub contents GET ${res.status}`)
    const file = await res.json()
    const lines = Buffer.from(file.content, 'base64').toString('utf8').split('\n')
    const i = lines.findIndex((l) => l.split(',')[0]?.trim() === gameId)
    if (i === -1) return log('csv_row_missing', { gameId })
    const cols = lines[i].split(',')
    if (cols[5]?.trim() !== 'open') return log('csv_already_updated', { gameId, status: cols[5] })
    cols[5] = 'closed'
    lines[i] = cols.join(',')
    const put = await fetch(GH().url, {
      method: 'PUT',
      headers: { ...GH().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `bot: close betting for ${gameId}`, content: Buffer.from(lines.join('\n')).toString('base64'), sha: file.sha, branch: 'main' }),
    })
    if (put.ok) return log('csv_updated', { gameId, status: 'closed' })
    if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub contents PUT ${put.status}: ${await put.text()}`)
    await sleep(1000 * attempt)
  }
  throw new Error(`could not update markets.csv for ${gameId} after 4 attempts`)
}

// ── Chain ────────────────────────────────────────────────────────────────────
async function setupChain() {
  const rpc = process.env.RPC_URL
  if (!rpc) throw new Error('RPC_URL is required')
  const owner = getAddress(process.env.PRODUCTION_WALLET || '')
  const factory = getAddress(process.env.FACTORY_ADDRESS || V1_6_FACTORY)
  const pub = createPublicClient({ chain: base, transport: http(rpc, { timeout: 60_000 }) })

  let account
  if (process.env.FORK_IMPERSONATE === 'true') {
    const client = await pub.request({ method: 'web3_clientVersion' })
    if (!String(client).includes('HardhatNetwork')) throw new Error('FORK_IMPERSONATE is only allowed against a Hardhat fork')
    await pub.request({ method: 'hardhat_impersonateAccount', params: [owner] })
    account = owner
  } else {
    const key = (process.env.PRIVATE_KEY || '').trim()
    if (!key) throw new Error('PRIVATE_KEY is required')
    account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
    // Same guard as the bot: a wrong key must never touch a market.
    if (getAddress(account.address) !== owner) throw new Error(`PRIVATE_KEY does not derive PRODUCTION_WALLET (${owner})`)
  }
  const wallet = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 60_000 }) })
  return { pub, wallet, owner, factory }
}

async function openOwnedMarkets({ pub, owner, factory }, csvRows) {
  const addresses = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getOpenMarkets' })
  const out = []
  for (const address of addresses) {
    const [gameId, marketOwner] = await Promise.all([
      pub.readContract({ address, abi: marketAbi, functionName: 'gameId' }),
      pub.readContract({ address, abi: marketAbi, functionName: 'owner' }),
    ])
    if (getAddress(marketOwner) !== owner) continue
    out.push({ address, gameId, gameDateMs: parseGameDate(csvRows.get(gameId)?.gameDate) })
  }
  return out
}

async function closeOne(chain, m, dryRun) {
  if (!(await chain.pub.readContract({ address: m.address, abi: marketAbi, functionName: 'bettingOpen' }))) {
    log('already_closed', { gameId: m.gameId, market: m.address })
    return true
  }
  const { request } = await chain.pub.simulateContract({ address: m.address, abi: marketAbi, functionName: 'closeBetting', account: chain.wallet.account })
  if (dryRun) {
    log('would_close', { gameId: m.gameId, market: m.address, closeAt: new Date(m.closeAtMs).toISOString() })
    return false
  }
  const hash = await chain.wallet.writeContract(request)
  const receipt = await chain.pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') throw new Error(`closeBetting ${hash} reverted on ${m.address}`)
  const block = await chain.pub.getBlock({ blockNumber: receipt.blockNumber })
  log('closed', {
    gameId: m.gameId, market: m.address, txHash: hash,
    gameDate: new Date(m.gameDateMs).toISOString(),
    closedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    secondsBeforeKickoff: Math.round(m.gameDateMs / 1000 - Number(block.timestamp)),
  })
  await markClosed(m.gameId).catch((err) => log('csv_update_failed', { gameId: m.gameId, error: err.message }))
  return true
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  log('output', { [key]: value })
}

async function main() {
  const cfg = {
    leadSeconds: int('CLOSE_LEAD_SECONDS', 60),
    pollSeconds: int('POLL_SECONDS', 30),
    maxRuntimeSeconds: int('MAX_RUNTIME_SECONDS', 5 * 3600 + 25 * 60),
    quietSeconds: 15 * 60,
  }
  cfg.hardCapSeconds = cfg.maxRuntimeSeconds + 20 * 60
  const dryRun = process.env.DRY_RUN === 'true'
  const chain = await setupChain()
  const started = Date.now()
  let csvRows = new Map(), csvReadAt = 0
  const warned = new Set()
  log('start', { owner: chain.owner, factory: chain.factory, dryRun, ...cfg })

  for (;;) {
    let next = null, remaining = 0
    try {
      if (Date.now() - csvReadAt > 5 * 60_000) { csvRows = parseCsv(await readCsvText()); csvReadAt = Date.now() }
      const markets = await openOwnedMarkets(chain, csvRows)
      const p = plan(markets, Date.now(), cfg.leadSeconds)
      for (const m of p.unknown) {
        if (!warned.has(m.address)) { warned.add(m.address); log('cannot_time_market', { gameId: m.gameId, market: m.address, gameDate: csvRows.get(m.gameId)?.gameDate ?? null }) }
      }
      let closedNow = 0
      for (const m of p.due) {
        try { if (await closeOne(chain, m, dryRun)) closedNow++ } catch (err) { log('close_failed', { gameId: m.gameId, market: m.address, error: err.shortMessage ?? err.message }) }
      }
      next = p.next
      remaining = markets.length - closedNow
      if (dryRun) {
        log('dry_run_plan', { open: markets.length, due: p.due.length, next: p.next && { gameId: p.next.gameId, closeAt: new Date(p.next.closeAtMs).toISOString() }, untimed: p.unknown.length })
        return setOutput('rearm', 'false')
      }
    } catch (err) {
      log('iteration_failed', { error: err.shortMessage ?? err.message })
      remaining = Math.max(remaining, 1) // unknown state: keep watching rather than exit
    }

    if (remaining === 0) { log('nothing_open', {}); return setOutput('rearm', 'false') }
    const now = Date.now()
    if (shouldHandOff({ elapsedSeconds: (now - started) / 1000, nextCloseAtMs: next?.closeAtMs ?? null, nowMs: now, ...cfg })) {
      log('handing_off', { remaining })
      return setOutput('rearm', 'true')
    }
    const untilNext = next ? next.closeAtMs - now : Infinity
    await sleep(Math.max(250, Math.min(cfg.pollSeconds * 1000, untilNext)))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { log('fatal', { error: err.shortMessage ?? err.message }); process.exit(1) })
}
