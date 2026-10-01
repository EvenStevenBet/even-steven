// Points v0 — a ledger, not a token. Writes data/points.json; no transfers, ever.
//
//   bet points      = stake (USDC) × POINTS_PER_USDC      to the bettor, every bet, win or lose
//   referral points = stake (USDC) × REF_POINTS_PER_USDC  to the ref's address, for bets it brought in
//
// Bets are enumerated from chain state — SportsbookFactory v1.6 getAllMarkets(), then each
// market's getBet(0 … n-1) — which is exactly what BetPlaced carries (fee aside) and needs no
// eth_getLogs range scans. Refs come from the attribution records the app writes to Upstash.
//
// Env: BASE_RPC_URL or ALCHEMY_RPC_URL (the public RPC rate-limits), KV_REST_API_URL and
// KV_REST_API_READ_ONLY_TOKEN (or KV_REST_API_TOKEN), POINTS_PER_USDC (100), REF_POINTS_PER_USDC (50).
// Usage: node scripts/points.mjs [--out data/points.json]

import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const V1_6_FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const MAX_BETS = 1000n
const USDC_UNIT = 1_000_000n
// Even Steven's own Base builder code: on every transaction, never a referrer.
export const ES_BUILDER_CODE = 'bc_ncytgilx'

const factoryAbi = parseAbi(['function getAllMarkets() view returns (address[])'])
const marketAbi = parseAbi([
  'function getMarketStatus() view returns (bool isCanceled, bool isPaused, bool assertionActive, uint256 claimDeadline, uint256 betsRemaining)',
  'struct Bet { address bettor; uint256 stake; bool greaterThan; int256 lockedZ; bool claimed; }',
  'function getBet(uint256 betId) view returns (Bet)',
])

function rate(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return BigInt(fallback)
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  return BigInt(raw)
}

/**
 * bets:    [{ marketAddress, betId, bettor, stake }]            stake in USDC base units (bigint)
 * records: [{ marketAddress, betId, refAddress, stake }]         from attr:tx:* (strings ok)
 * Points are floored per bet, so a 1.5 USDC stake at 100/USDC is exactly 150.
 */
export function computePoints(bets, records, { pointsPerUsdc, refPointsPerUsdc }) {
  const rows = new Map()
  const row = (addr) => {
    const key = addr.toLowerCase()
    if (!rows.has(key)) rows.set(key, { betPoints: 0n, referralPoints: 0n })
    return rows.get(key)
  }
  const betKey = (m, id) => `${m.toLowerCase()}:${BigInt(id)}`

  const onChain = new Map()
  for (const bet of bets) {
    onChain.set(betKey(bet.marketAddress, bet.betId), bet)
    row(bet.bettor).betPoints += (BigInt(bet.stake) * pointsPerUsdc) / USDC_UNIT
  }

  // A record only counts for a bet that exists on-chain with the same stake, and never for
  // the bettor themselves (the app already drops self-referral; this is belt and braces).
  const seen = new Set()
  for (const rec of records) {
    if (!rec?.refAddress || rec.ref?.toLowerCase() === ES_BUILDER_CODE) continue
    const key = betKey(rec.marketAddress, rec.betId)
    const bet = onChain.get(key)
    if (!bet || seen.has(key) || BigInt(rec.stake) !== BigInt(bet.stake)) continue
    if (rec.refAddress.toLowerCase() === bet.bettor.toLowerCase()) continue
    seen.add(key)
    row(rec.refAddress).referralPoints += (BigInt(bet.stake) * refPointsPerUsdc) / USDC_UNIT
  }

  return [...rows.entries()]
    .map(([address, r]) => ({
      address,
      total: Number(r.betPoints + r.referralPoints),
      betPoints: Number(r.betPoints),
      referralPoints: Number(r.referralPoints),
    }))
    .sort((a, b) => b.total - a.total || a.address.localeCompare(b.address))
}

export async function readBets(client) {
  const markets = await client.readContract({ address: V1_6_FACTORY, abi: factoryAbi, functionName: 'getAllMarkets' })
  const bets = []
  for (const market of markets) {
    const status = await client.readContract({ address: market, abi: marketAbi, functionName: 'getMarketStatus' })
    const count = MAX_BETS - status[4]
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i))
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const results = await client.multicall({
        allowFailure: false,
        contracts: chunk.map((id) => ({ address: market, abi: marketAbi, functionName: 'getBet', args: [id] })),
      })
      results.forEach((b, j) => bets.push({ marketAddress: market, betId: chunk[j], bettor: b.bettor, stake: b.stake }))
    }
  }
  return { markets, bets }
}

async function upstash(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('KV_REST_API_URL and KV_REST_API_READ_ONLY_TOKEN are required to read attribution records')
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(command) })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(`Upstash ${command[0]} failed: ${body.error ?? res.status}`)
  return body.result
}

/** All attribution records, optionally only those with fromTs <= ts < toTs (unix seconds). */
export async function readAttributionRecords({ fromTs, toTs } = {}) {
  const hashes = fromTs === undefined
    ? await upstash(['ZRANGE', 'attr:index', '0', '-1'])
    : await upstash(['ZRANGE', 'attr:index', String(fromTs), `(${toTs}`, 'BYSCORE'])
  const records = []
  for (let i = 0; i < hashes.length; i += 100) {
    const values = await upstash(['MGET', ...hashes.slice(i, i + 100).map((h) => `attr:tx:${h}`)])
    for (const v of values) if (v) records.push(typeof v === 'string' ? JSON.parse(v) : v)
  }
  return records
}

async function main() {
  const outArg = process.argv.indexOf('--out')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const out = outArg !== -1 ? process.argv[outArg + 1] : path.join(repoRoot, 'data', 'points.json')

  const rates = { pointsPerUsdc: rate('POINTS_PER_USDC', 100), refPointsPerUsdc: rate('REF_POINTS_PER_USDC', 50) }
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || process.env.ALCHEMY_RPC_URL || undefined), batch: { multicall: true } })

  const { markets, bets } = await readBets(client)
  const records = await readAttributionRecords()
  const addresses = computePoints(bets, records, rates)

  const payload = {
    pointsPerUsdc: Number(rates.pointsPerUsdc),
    refPointsPerUsdc: Number(rates.refPointsPerUsdc),
    factory: V1_6_FACTORY,
    markets: markets.length,
    bets: bets.length,
    addresses,
  }

  // Skip the write when nothing but the timestamp would change, so the hourly job only commits real updates.
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(out, 'utf8')) } catch {}
  if (previous) {
    const { updatedAt, ...rest } = previous
    if (JSON.stringify(rest) === JSON.stringify(payload)) {
      console.log(`points unchanged: ${addresses.length} addresses, ${bets.length} bets`)
      return
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ updatedAt: new Date().toISOString(), ...payload }, null, 2) + '\n')
  console.log(`wrote ${out}: ${addresses.length} addresses, ${bets.length} bets across ${markets.length} markets, ${records.length} attribution records`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
