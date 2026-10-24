#!/usr/bin/env node
// Prints each approved builder's links for the open markets. Read-only: it changes nothing.
// For Jeff only. ES - Context: only Jeff hands out referral links, and bots never write, build or send one.
// Run it by hand; never from a bot, a workflow or a scheduled job, and never paste its output into bot copy.
//
//   node scripts/builder-links.mjs
//
// One line per builder per market: the plain link, then the &side=home and &side=away variants.
// Open markets are the rows of data/markets.csv whose status is "open" and that have a market address.
// Approved builders are the rows of builders.json with approved: true and a valid payoutAddress,
// the same filter the site applies (Web App/lib/refs.ts), so a code printed here is a code that resolves.
//
// Env:
//   BUILDERS_JSON   local path or URL of builders.json
//                   (default: even-steven-app main on raw.githubusercontent.com)
//   MARKETS_CSV     local path or URL of markets.csv (default: data/markets.csv in this repo)
//   SITE_URL        default https://evensteven.bet

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BUILDERS = 'https://raw.githubusercontent.com/EvenStevenBet/even-steven-app/main/data/builders.json'
const CODE = /^[a-z0-9-]{3,32}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Pure. Rows that earn: approved === true, a valid code and a valid payout address. */
export function approvedBuilders(rows) {
  if (!Array.isArray(rows)) throw new Error('builders.json must be an array')
  return rows
    .filter(b => b && b.approved === true && typeof b.code === 'string' && CODE.test(b.code.toLowerCase()) && ADDRESS.test(String(b.payoutAddress)))
    .map(b => ({ code: b.code.toLowerCase(), label: b.label ?? '' }))
}

/** Pure. Open markets from the 11-column markets.csv (no quoted fields). */
export function openMarkets(csvText) {
  const out = []
  for (const line of csvText.split('\n').slice(1)) {
    const c = line.replace(/\r$/, '').split(',')
    const gameId = (c[0] ?? '').trim(), status = (c[5] ?? '').trim(), market = (c[6] ?? '').trim()
    if (gameId && status === 'open' && ADDRESS.test(market)) out.push({ gameId, market })
  }
  return out
}

/** Pure. The three links for one builder and one market. */
export function linksFor(site, gameId, code) {
  const base = `${site.replace(/\/$/, '')}/market/${encodeURIComponent(gameId)}?ref=${encodeURIComponent(code)}`
  return { any: base, home: `${base}&side=home`, away: `${base}&side=away` }
}

/** Pure. One line per builder per market. */
export function lines(site, builders, markets) {
  return builders.flatMap(b => markets.map(m => {
    const l = linksFor(site, m.gameId, b.code)
    return `${b.code}\t${m.gameId}\tany: ${l.any}\thome: ${l.home}\taway: ${l.away}`
  }))
}

async function read(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${source}`)
    return res.text()
  }
  return fs.readFileSync(source, 'utf8')
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const builders = approvedBuilders(JSON.parse(await read(process.env.BUILDERS_JSON || DEFAULT_BUILDERS)))
  const markets = openMarkets(await read(process.env.MARKETS_CSV || path.join(root, 'data/markets.csv')))
  if (builders.length === 0) { console.error('no approved builders: nothing to print'); return }
  if (markets.length === 0) { console.error('no open markets in markets.csv: nothing to print'); return }
  for (const l of lines(process.env.SITE_URL || 'https://evensteven.bet', builders, markets)) console.log(l)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`error: ${err.message}`); process.exit(1) })
}
