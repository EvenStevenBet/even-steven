// Kickoff closer — closes betting on every open market this wallet owns at its CSV gameDate,
// without anyone clicking. Runs as a long-lived GitHub Actions job (.github/workflows/
// kickoff-closer.yml): it re-reads the open markets every POLL_SECONDS, sleeps precisely until
// the next close is due, sends closeBetting(), then marks the row closed in data/markets.csv, and
// before the 6-hour job limit hands off to a fresh run while any open market remains. Every CSV
// re-read also brings rows still saying open/closed up to their on-chain state (closed, settled).
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
//   GITHUB_TOKEN + GITHUB_REPOSITORY   read the CSV from, and write statuses back to, main
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
  'function settled() view returns (bool)',
  'function canceled() view returns (bool)',
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

/**
 * Pure. What the watcher does after an iteration.
 * A market it can't time (no CSV row, or a bad gameDate) is never guessed at; it fails the job
 * so GitHub notifies. With timed markets still open the watcher keeps closing those and fails
 * at the end of its run; with only untimed markets left it fails at once and does not re-arm
 * (the cron retries, and each retry fails again until the row is fixed).
 */
export function outcome({ timedRemaining, untimedRemaining, iterationFailed }) {
  if (iterationFailed || timedRemaining > 0) return 'continue'
  return untimedRemaining > 0 ? 'fail' : 'done'
}

/** Pure. Rows by gameId from the 11-column markets.csv (no quoted fields, same as the bot). */
export function parseCsv(text) {
  const rows = new Map()
  for (const line of text.split('\n').slice(1)) {
    const cols = line.replace(/\r$/, '').split(',')
    const gameId = (cols[0] ?? '').trim()
    if (gameId) rows.set(gameId, { gameDate: (cols[4] ?? '').trim(), status: (cols[5] ?? '').trim(), marketAddress: (cols[6] ?? '').trim() })
  }
  return rows
}

// CSV statuses only ever move forward. The terminal ones are never rewritten.
const STATUS_RANK = { open: 0, closed: 1, settled: 2, refund: 2, cancelled: 2, canceled: 2 }

/** Pure. True when writing `next` over `current` moves the row forward. */
export function advances(current, next) {
  const c = STATUS_RANK[current], n = STATUS_RANK[next]
  return c !== undefined && n !== undefined && n > c
}

/**
 * Pure. CSV status for a market's on-chain flags. cancelMarket() and triggerRefund() set the same
 * flags (canceled, refundMode); only their events differ, so that case is left to a human.
 */
export function chainStatus({ bettingOpen, settled, canceled }) {
  if (canceled) return 'cancelled_or_refund'
  if (settled) return 'settled'
  return bettingOpen ? 'open' : 'closed'
}

/** Pure. Rows still saying open or closed, with an address, whose market is not open on chain. */
export function reconcileCandidates(csvRows, openAddresses) {
  const open = new Set(openAddresses.map((a) => a.toLowerCase()))
  const out = []
  for (const [gameId, r] of csvRows) {
    if ((r.status === 'open' || r.status === 'closed') && /^0x[0-9a-fA-F]{40}$/.test(r.marketAddress) &&
        !open.has(r.marketAddress.toLowerCase())) {
      out.push({ gameId, marketAddress: r.marketAddress, status: r.status })
    }
  }
  return out
}

/** Pure. Reconcile only when no close is due within quietMs, so it can never delay one. */
export function shouldReconcile(nextCloseAtMs, nowMs, quietMs) {
  return nextCloseAtMs === null || nextCloseAtMs - nowMs > quietMs
}

/**
 * Pure. The watch step's exit code, decided once at the end of the run. A failed CSV write fails
 * only the run that ends the watch (rearm false): while markets remain open it is annotated and
 * the next run's reconcile retries it, so it can never stand between a market and its close.
 */
export function exitCodeFor({ rearm, sawUntimed, untimedOnly, csvFailures }) {
  if (sawUntimed || untimedOnly) return 1
  return rearm === 'false' && csvFailures > 0 ? 1 : 0
}

/**
 * One watcher pass. io: { now, readCsvText, openOwnedMarkets, closeOne, marketState, writeStatus, log }.
 * Every due close is sent before any CSV write, and no CSV error can reach a close: a failed
 * re-read keeps the rows already in hand, and each write is caught on its own.
 */
export async function runPass(state, io, cfg) {
  let csvFresh = false
  if (io.now() - state.csvReadAt > cfg.csvMaxAgeMs) {
    try {
      state.csvRows = parseCsv(await io.readCsvText())
      state.csvReadAt = io.now()
      csvFresh = true
    } catch (err) {
      if (state.csvReadAt === 0) throw err // no rows yet: nothing can be timed
      io.log('csv_read_failed', { error: err.message, usingRowsReadAt: new Date(state.csvReadAt).toISOString() })
    }
  }

  const markets = await io.openOwnedMarkets(state.csvRows)
  const p = plan(markets, io.now(), cfg.leadSeconds)

  const closed = []
  for (const m of p.due) {
    try { if (await io.closeOne(m)) closed.push(m) } catch (err) {
      io.log('close_failed', { gameId: m.gameId, market: m.address, error: err.shortMessage ?? err.message })
    }
  }

  let csvFailures = 0
  const write = async (gameId, status) => {
    try { await io.writeStatus(gameId, status) } catch (err) {
      csvFailures++
      io.log('csv_update_failed', { gameId, status, error: err.message })
    }
  }
  if (!cfg.dryRun) for (const m of closed) await write(m.gameId, 'closed')

  if (csvFresh && shouldReconcile(p.next?.closeAtMs ?? null, io.now(), cfg.reconcileQuietMs)) {
    for (const r of reconcileCandidates(state.csvRows, markets.map((m) => m.address))) {
      let target
      try { target = chainStatus(await io.marketState(r.marketAddress)) } catch (err) {
        io.log('csv_reconcile_read_failed', { gameId: r.gameId, market: r.marketAddress, error: err.shortMessage ?? err.message })
        continue
      }
      if (target === 'cancelled_or_refund') {
        io.log('csv_reconcile_needs_human', { gameId: r.gameId, market: r.marketAddress, status: r.status,
          detail: 'canceled on chain: set cancelled (cancelMarket) or refund (triggerRefund) by hand' })
        continue
      }
      if (!advances(r.status, target)) continue
      if (cfg.dryRun) { io.log('would_update_status', { gameId: r.gameId, from: r.status, to: target }); continue }
      io.log('csv_reconcile', { gameId: r.gameId, market: r.marketAddress, from: r.status, to: target })
      await write(r.gameId, target)
    }
  }

  return { markets, plan: p, closedCount: closed.length, csvFailures }
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

/**
 * Moves the gameId's row forward to `status` (never back), same commit messages as the bot.
 * Retries a stale sha and GitHub 5xx; anything else throws to the caller.
 */
async function writeStatus(gameId, status) {
  if (!canWriteBack()) return log('csv_write_skipped', { gameId, status, reason: 'no GITHUB_TOKEN/GITHUB_REPOSITORY, or MARKETS_CSV override' })
  const retryable = (s) => s === 409 || s === 422 || s >= 500
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${GH().url}?ref=main`, { headers: GH().headers })
    if (!res.ok) {
      if (retryable(res.status) && attempt < 4) { await sleep(2000 * attempt); continue }
      throw new Error(`GitHub contents GET ${res.status}`)
    }
    const file = await res.json()
    const lines = Buffer.from(file.content, 'base64').toString('utf8').split('\n')
    const i = lines.findIndex((l) => l.split(',')[0]?.trim() === gameId)
    if (i === -1) return log('csv_row_missing', { gameId })
    const cols = lines[i].split(',')
    // A row ending in CRLF keeps it: the \r rides on the last column.
    const current = (cols[5] ?? '').trim()
    if (!advances(current, status)) return log('csv_already_updated', { gameId, status: current })
    cols[5] = status
    lines[i] = cols.join(',')
    const verb = status === 'closed' ? 'close betting for' : `set status ${status} on`
    const put = await fetch(GH().url, {
      method: 'PUT',
      headers: { ...GH().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `bot: ${verb} ${gameId}`, content: Buffer.from(lines.join('\n')).toString('base64'), sha: file.sha, branch: 'main' }),
    })
    if (put.ok) return log('csv_updated', { gameId, from: current, status })
    if (!retryable(put.status) || attempt === 4) throw new Error(`GitHub contents PUT ${put.status}: ${await put.text()}`)
    await sleep(2000 * attempt)
  }
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
  // The close is final at this point. The block's timestamp is for the log only: a load-balanced
  // RPC can answer "block not found" for a block whose receipt it just served (it did on
  // 2026-10-04 at 49ers/Broncos), and that must not be reported as a failed close.
  let closedAtS = null
  try { closedAtS = Number((await chain.pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp) } catch (err) {
    log('close_block_lookup_failed', { gameId: m.gameId, block: String(receipt.blockNumber), error: err.shortMessage ?? err.message })
  }
  log('closed', {
    gameId: m.gameId, market: m.address, txHash: hash, block: String(receipt.blockNumber),
    gameDate: new Date(m.gameDateMs).toISOString(),
    closedAt: closedAtS === null ? null : new Date(closedAtS * 1000).toISOString(),
    secondsBeforeKickoff: closedAtS === null ? null : Math.round(m.gameDateMs / 1000 - closedAtS),
  })
  return true
}

async function marketState({ pub }, address) {
  const read = (functionName) => pub.readContract({ address, abi: marketAbi, functionName })
  const [bettingOpen, settled, canceled] = await Promise.all([read('bettingOpen'), read('settled'), read('canceled')])
  return { bettingOpen, settled, canceled }
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
  const state = { csvRows: new Map(), csvReadAt: 0 }
  const io = {
    now: () => Date.now(),
    readCsvText,
    openOwnedMarkets: (rows) => openOwnedMarkets(chain, rows),
    closeOne: (m) => closeOne(chain, m, dryRun),
    marketState: (address) => marketState(chain, address),
    writeStatus,
    log,
  }
  const passCfg = { leadSeconds: cfg.leadSeconds, csvMaxAgeMs: 5 * 60_000, reconcileQuietMs: cfg.quietSeconds * 1000, dryRun }
  const warned = new Set()
  let sawUntimed = false, csvFailures = 0
  let announced = null
  // The only place the exit code is set: once, as the run ends.
  const finish = (rearm, untimedOnly = false) => {
    if (csvFailures > 0) console.log(`::error title=markets.csv not updated::${csvFailures} status write(s) failed this run; the next run's reconcile retries them.`)
    process.exitCode = exitCodeFor({ rearm, sawUntimed, untimedOnly, csvFailures })
    setOutput('rearm', rearm)
  }
  log('start', { owner: chain.owner, factory: chain.factory, dryRun, ...cfg })

  for (;;) {
    let next = null, timedRemaining = 0, untimedRemaining = 0, iterationFailed = false
    try {
      const { markets, plan: p, closedCount, csvFailures: failedNow } = await runPass(state, io, passCfg)
      csvFailures += failedNow
      for (const m of p.unknown) {
        if (warned.has(m.address)) continue
        warned.add(m.address)
        sawUntimed = true
        const gameDate = state.csvRows.get(m.gameId)?.gameDate ?? null
        log('cannot_time_market', { gameId: m.gameId, market: m.address, gameDate })
        console.log(`::error title=Kickoff closer cannot time a market::${m.gameId} (${m.address}) has ${gameDate === null ? 'no row in data/markets.csv' : `an invalid gameDate "${gameDate}"`}. Fix the row or close it by hand.`)
      }
      const closedNow = closedCount
      next = p.next
      if (next && !dryRun && announced !== `${next.address}:${next.closeAtMs}`) {
        announced = `${next.address}:${next.closeAtMs}`
        log('next_close', { gameId: next.gameId, market: next.address, gameDate: new Date(next.gameDateMs).toISOString(), closeAt: new Date(next.closeAtMs).toISOString(), leadSeconds: cfg.leadSeconds })
      }
      untimedRemaining = p.unknown.length
      timedRemaining = markets.length - p.unknown.length - closedNow
      if (dryRun) {
        log('dry_run_plan', { open: markets.length, due: p.due.length, next: p.next && { gameId: p.next.gameId, closeAt: new Date(p.next.closeAtMs).toISOString() }, untimed: p.unknown.length })
        return finish('false')
      }
    } catch (err) {
      log('iteration_failed', { error: err.shortMessage ?? err.message })
      iterationFailed = true // unknown state: keep watching rather than exit
    }

    const result = outcome({ timedRemaining, untimedRemaining, iterationFailed })
    if (result === 'done') {
      log('nothing_open', {})
      return finish('false')
    }
    if (result === 'fail') {
      log('only_untimed_markets_left', { untimedRemaining })
      return finish('false', true)
    }
    const now = Date.now()
    if (shouldHandOff({ elapsedSeconds: (now - started) / 1000, nextCloseAtMs: next?.closeAtMs ?? null, nowMs: now, ...cfg })) {
      log('handing_off', { timedRemaining, untimedRemaining })
      return finish('true')
    }
    const untilNext = next ? next.closeAtMs - now : Infinity
    await sleep(Math.max(250, Math.min(cfg.pollSeconds * 1000, untilNext)))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { log('fatal', { error: err.shortMessage ?? err.message }); process.exit(1) })
}
