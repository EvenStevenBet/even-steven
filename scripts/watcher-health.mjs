// Watcher health check — used by .github/workflows/watcher-health.yml.
// Exported for unit tests; call runHealthCheck() directly.
//
// Logic:
//   1. Read open markets from the factory (onchain).
//   2. For each, look up the gameDate in markets.csv.
//   3. If any market has kickoff within `windowHours`, check the GitHub Actions
//      API for an active or queued kickoff-closer run.
//   4. If at-risk markets exist and no watcher is active/queued → fail loudly.
//
// Env (when used via the workflow):
//   RPC_URL, FACTORY_ADDRESS, PRODUCTION_WALLET — same secrets as the closer
//   GITHUB_TOKEN + GITHUB_REPOSITORY               — provided by the runner
//   DRY_RUN=true                                   — log, don't fail

import { createPublicClient, getAddress, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { parseCsv } from './kickoff-closer.mjs'

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))

const factoryAbi = parseAbi(['function getOpenMarkets() view returns (address[])'])
const marketAbi = parseAbi([
  'function gameId() view returns (string)',
  'function owner() view returns (address)',
])

/** Fetch open market addresses from the factory, filtered to the production wallet. */
export async function getOwnedOpenMarkets(rpcUrl, factoryAddress, ownerAddress) {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 30_000 }) })
  const addresses = await client.readContract({ address: getAddress(factoryAddress), abi: factoryAbi, functionName: 'getOpenMarkets' })
  const owner = getAddress(ownerAddress)
  const out = []
  for (const address of addresses) {
    const [gameId, marketOwner] = await Promise.all([
      client.readContract({ address, abi: marketAbi, functionName: 'gameId' }),
      client.readContract({ address, abi: marketAbi, functionName: 'owner' }),
    ])
    if (getAddress(marketOwner) === owner) out.push({ address, gameId })
  }
  return out
}

/** Fetch and parse data/markets.csv from the given URL. */
export async function fetchCsv(url, githubToken) {
  const headers = githubToken
    ? { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : {}
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`markets.csv fetch ${res.status}`)
  return parseCsv(await res.text())
}

/**
 * Check the GitHub Actions API for any active or queued kickoff-closer run.
 * Returns the run that is active/queued, or null if none.
 */
export async function findActiveWatcherRun(githubToken, githubRepo) {
  // 'in_progress', 'queued', and 'waiting' all mean a watcher is active or about to run.
  const statuses = ['in_progress', 'queued', 'waiting']
  for (const status of statuses) {
    const url = `https://api.github.com/repos/${githubRepo}/actions/workflows/kickoff-closer.yml/runs?status=${status}&per_page=1`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Actions API ${res.status} for status=${status}`)
    const data = await res.json()
    if (data.workflow_runs?.length > 0) return data.workflow_runs[0]
  }
  return null
}

/**
 * Pure. Given markets with gameDateMs, returns those with kickoff within windowHours.
 */
export function atRiskMarkets(markets, nowMs, windowHours) {
  const windowMs = windowHours * 3600_000
  return markets.filter((m) => {
    if (m.gameDateMs === null) return false // untimed markets are the closer's problem, not ours
    return m.gameDateMs - nowMs <= windowMs && m.gameDateMs > nowMs // upcoming but within window
  })
}

/**
 * Main entry point. Options:
 *   rpcUrl, factoryAddress, productionWallet — chain config
 *   githubToken, githubRepo                  — GitHub API access
 *   marketsUrl                               — URL for markets.csv (raw GitHub or API)
 *   windowHours                              — how far ahead to look (default 12)
 *   dryRun                                   — log but don't fail
 *   now                                      — injectable for tests
 *   _fetchOwnedMarkets, _fetchCsv, _findActiveRun — injectable for tests
 */
export async function runHealthCheck({
  rpcUrl,
  factoryAddress,
  productionWallet,
  githubToken,
  githubRepo,
  marketsUrl,
  windowHours = 12,
  dryRun = false,
  now = Date.now(),
  _fetchOwnedMarkets = null,
  _fetchCsv = null,
  _findActiveRun = null,
}) {
  const fetchOwnedMarkets = _fetchOwnedMarkets ?? (() => getOwnedOpenMarkets(rpcUrl, factoryAddress, productionWallet))
  const fetchCsvFn = _fetchCsv ?? (() => fetchCsv(marketsUrl, githubToken))
  const findActiveRunFn = _findActiveRun ?? (() => findActiveWatcherRun(githubToken, githubRepo))

  const [markets, csvRows] = await Promise.all([fetchOwnedMarkets(), fetchCsvFn()])

  log('health_check_start', { openMarkets: markets.length, windowHours, dryRun })

  // Annotate each market with its gameDateMs from CSV.
  const annotated = markets.map((m) => {
    const row = csvRows.get(m.gameId)
    const gameDateMs = row?.gameDate ? new Date(row.gameDate).getTime() : null
    return { ...m, gameDateMs: isNaN(gameDateMs) ? null : gameDateMs }
  })

  const atRisk = atRiskMarkets(annotated, now, windowHours)

  if (atRisk.length === 0) {
    log('health_check_ok', { reason: 'no markets with kickoff within window', windowHours })
    return
  }

  log('health_check_at_risk', { count: atRisk.length, markets: atRisk.map((m) => ({ gameId: m.gameId, gameDate: m.gameDateMs ? new Date(m.gameDateMs).toISOString() : null })) })

  // At-risk markets exist — verify there's a watcher.
  const activeRun = await findActiveRunFn()
  if (activeRun) {
    log('health_check_ok', {
      reason: 'watcher is active or queued',
      runId: activeRun.id,
      status: activeRun.status,
      atRiskCount: atRisk.length,
    })
    return
  }

  // No watcher and at-risk markets → alarm.
  const msg = `${atRisk.length} market(s) have kickoff within ${windowHours}h but NO kickoff-closer watcher is active or queued. ` +
    `Start the Kickoff closer workflow manually NOW: ${atRisk.map((m) => m.gameId).join(', ')}`

  log('health_check_failed', { atRiskMarkets: atRisk.map((m) => m.gameId), watcherActive: false })
  console.log(`::error title=Watcher health check failed::${msg}`)

  if (dryRun) {
    log('health_check_dry_run', { detail: 'DRY_RUN — would have failed the job here' })
    return
  }

  process.exitCode = 1
}
