#!/usr/bin/env node
// Even Steven skill for Bankr agents. Non-custodial: the Bankr wallet signs a USDC
// ReceiveWithAuthorization through POST /wallet/sign, Even Steven's relay submits it and pays the
// gas, and USDC moves straight from the bettor to the market. This script never submits a
// transaction itself and never calls /wallet/submit, /wallet/transfer or /wallet/swap.
//
//   node scripts/even-steven.mjs markets [--all]
//   node scripts/even-steven.mjs odds "<game>" [--stake 10] [--all]
//   node scripts/even-steven.mjs bet --prepare "<game>" <side> <stake>
//   node scripts/even-steven.mjs bet --confirm <intent-id>
//   node scripts/even-steven.mjs status "<game>"
//   node scripts/even-steven.mjs claim "<game>"
//
// Environment: BANKR_CONFIG (default ~/.bankr/config.json, holds the API key), ES_MAX_STAKE
// (default 25), ES_REF (optional, unset by default), ES_STATE_DIR, BASE_RPC_URL.
// The API key is read from the Bankr config, sent only as the X-API-Key header to
// api.bankr.bot, and never printed or written anywhere.
import { createPublicClient, http, getAddress, isAddress, keccak256, encodeAbiParameters, hashTypedData,
         recoverAddress, parseAbi, size, formatUnits } from 'viem'
import { base } from 'viem/chains'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

// ---- pinned values -------------------------------------------------------------------------
export const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const API_BASE = 'https://evensteven.bet'
export const BANKR_API = 'https://api.bankr.bot'
export const BASESCAN = 'https://basescan.org'
export const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }
export const RWA_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
}
export const MIN_STAKE = 1_000_000n
export const DEFAULT_MAX_STAKE = 25
export const VALID_WINDOW = 600            // seconds the authorization stays valid
export const INTENT_TTL = 300              // seconds a prepared bet can be confirmed
export const SUBMIT_LOCK = 300             // the relay's duplicate lock after a submission
export const MAGIC_1271 = '0x1626ba7e'
export const CLAIM_SENTENCE = 'Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.'

const FACTORY_ABI = parseAbi([
  'function getOpenMarkets() view returns (address[])',
  'function getAllMarkets() view returns (address[])',
  'function gameIdByMarket(address) view returns (string)',
])
const MARKET_ABI = parseAbi([
  'function FEE_PERCENT() view returns (uint256)',
  'function getMarketState() view returns (string gameId, int256 z, uint256 gPool, uint256 lePool, uint256 tPool, bool isOpen, bool isSettled)',
  'function getMarketEV(uint256 stake, bool greaterThan) view returns (uint256 currentPayout, uint256 liquidPayout, uint256 impliedVig)',
  'function getBetsByAddress(address) view returns (uint256[])',
  'function getBet(uint256) view returns ((address bettor, uint256 stake, bool greaterThan, int256 lockedZ, bool claimed))',
])
const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)'])

// ---- small helpers -------------------------------------------------------------------------
const usd = (n) => (Number(formatUnits(BigInt(n), 6))).toFixed(2)
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')

export function parseStake(text, maxStakeUsdc = DEFAULT_MAX_STAKE) {
  if (!/^\d+(\.\d{1,6})?$/.test(String(text))) throw new UserError(`"${text}" is not a USDC amount. Use a number like 5 or 12.50.`)
  const [w, f = ''] = String(text).split('.')
  const stake = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'))
  if (stake < MIN_STAKE) throw new UserError('The minimum stake is 1 USDC.')
  const max = BigInt(Math.round(Number(maxStakeUsdc) * 1e6))
  if (!(max > 0n)) throw new UserError('ES_MAX_STAKE must be a positive number.')
  if (stake > max) throw new UserError(`That is over the maximum stake of ${usd(max)} USDC. Ask for a smaller amount, or the owner of this wallet can raise ES_MAX_STAKE.`)
  return stake
}

export class UserError extends Error {}

export function deriveNonce(salt, greaterThan) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
}

// ---- line math (ported from the site's lib/line.ts; home wins iff margin >= winThreshold) --
const Z_SCALE = 10_000n
function floorDiv(a, b) { const q = a / b; return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q }
export const winThreshold = (z) => Number(floorDiv(BigInt(z), Z_SCALE) + 1n)
const sideSpreadNum = (z, side) => { const v = Number(z) / 10_000; return side === 'home' ? -v : v }
export function formatSpread(z, side) {
  const r = Math.round(sideSpreadNum(z, side) * 10) / 10
  if (BigInt(z) === 0n || r === 0) return "PICK'EM"
  const body = Number.isInteger(Math.abs(r)) ? String(Math.abs(r)) : Math.abs(r).toFixed(1)
  return `${r > 0 ? '+' : '-'}${body}`
}
function outcomeText(z, side) {
  const m = winThreshold(z)
  const need = side === 'home' ? m : 1 - m
  if (need >= 2) return `win by ${need} or more`
  if (need === 1) return 'win outright'
  if (need === 0) return 'win or tie'
  if (need === -1) return 'win, tie, or lose by 1'
  return `win, tie, or lose by up to ${-need}`
}
export function lineSentence(z, side, home, away) {
  const team = side === 'home' ? home : away
  return `${team} ${formatSpread(z, side)}: you win if the ${team} ${outcomeText(z, side)}`
}
export function favoriteHeadline(z, home, away) {
  const v = Number(z) / 10_000
  const by = Math.round(Math.abs(v) * 10) / 10
  if (BigInt(z) === 0n || by === 0) return "Pick'em, no favorite"
  const team = v > 0 ? home : away
  return `${team} favored by ${Number.isInteger(by) ? by : by.toFixed(1)}`
}
export function parseGameId(gameId) {
  const m = /^([A-Z0-9]+)-(\d{4}-\d{2}-\d{2})-HOME-(.+?)-AWAY-(.+?)(-G\d)?$/.exec(gameId)
  return m ? { sport: m[1], date: m[2], home: m[3], away: m[4] } : { sport: '', date: '', home: 'Home', away: 'Away' }
}

// ---- market lookup and matching ------------------------------------------------------------
async function readMarket(pc, address) {
  const [gameId, z, gPool, lePool, tPool, isOpen, isSettled] =
    await pc.readContract({ address, abi: MARKET_ABI, functionName: 'getMarketState' })
  return { address: getAddress(address), gameId, z, gPool, lePool, tPool, isOpen, isSettled, ...parseGameId(gameId) }
}
export async function listMarkets(pc, scope = 'open', factory = FACTORY) {
  const fn = scope === 'open' ? 'getOpenMarkets' : 'getAllMarkets'
  let addrs = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: fn })
  if (scope !== 'open') addrs = addrs.slice(-30)
  return Promise.all(addrs.map((a) => readMarket(pc, a)))
}
const STOP = new Set(['vs', 'v', 'at', 'the', 'game', 'home', 'away', 'bet', 'on'])
/** Match a user's words against known markets. Returns { match } | { ambiguous: [...] } | { none: true }. */
export function matchMarket(query, markets) {
  const q = String(query).trim()
  if (isAddress(q)) {
    const hit = markets.filter((m) => m.address.toLowerCase() === q.toLowerCase())
    return hit.length ? { match: hit[0] } : { none: true }
  }
  const exact = markets.filter((m) => m.gameId.toLowerCase() === q.toLowerCase())
  if (exact.length === 1) return { match: exact[0] }
  const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t))
  if (!tokens.length) return { none: true }
  const hits = markets.filter((m) => { const g = norm(m.gameId); return tokens.every((t) => g.includes(t)) })
  if (hits.length === 1) return { match: hits[0] }
  return hits.length ? { ambiguous: hits } : { none: true }
}
/** Side from "home" / "away" or a team name of this game. */
export function parseSide(text, market) {
  const t = norm(text)
  if (t === 'home') return { greaterThan: true, side: 'home' }
  if (t === 'away') return { greaterThan: false, side: 'away' }
  const h = norm(market.home), a = norm(market.away)
  const isH = t.length >= 2 && (h.includes(t) || t.includes(h)), isA = t.length >= 2 && (a.includes(t) || t.includes(a))
  if (isH && !isA) return { greaterThan: true, side: 'home' }
  if (isA && !isH) return { greaterThan: false, side: 'away' }
  return null
}

// ---- relay error table (AGENTS.md) ---------------------------------------------------------
// kind: retry (resend the IDENTICAL request), status (check the chain first; never re-sign),
//       resign (nothing was submitted; a fresh prepare and confirm is needed), stop (give up).
export function explainBetError(status, body) {
  const e = body?.error || ''
  const r = body?.reason || ''
  const mk = (kind, line, action, extra = {}) => ({ kind, line, action, ...extra })
  if (status === 429 && e === 'RateLimited') return mk('retry', 'Too many requests from this IP.', `Resend the identical request after ${body.retryAfterSeconds ?? 60} seconds.`, { wait: body.retryAfterSeconds ?? 60 })
  if (status === 429 && e === 'TooManyFailedSubmissions') return mk('stop', 'Three recent submissions for this wallet or IP reverted, so the relay is refusing more.', 'Stop. This clears 24 hours after the latest failure.')
  if (e === 'DuplicateSubmission') return mk('status', 'This authorization was already sent in the last 5 minutes.', 'Do not re-sign. Check the chain for the bet.')
  if (e === 'SubmissionPending') return mk('status', `The transaction was sent but not mined yet${body.txHash ? ` (${body.txHash})` : ''}.`, 'Do not re-sign. Check the chain for the bet.')
  if (e === 'SubmissionFailed') return mk('status', 'The relay could not send the transaction.', 'Check the chain; if no bet landed, resend the identical request after the 5-minute lock.')
  if (e === 'SubmissionReverted') return mk('status', `The transaction reverted${body.txHash ? ` (${body.txHash})` : ''}, usually because the market changed. Your authorization is still unused.`, 'Check the chain; at most one identical retry after the 5-minute lock.')
  if (e === 'CustodyInvariantViolated') return mk('stop', `The relay's receipt check failed${body.txHash ? ` (${body.txHash})` : ''}. This should never happen.`, 'Stop and report the transaction hash to evenstevenbet@gmail.com.')
  if (e === 'InternalError') return mk('status', 'Unexpected server error.', 'Check the chain for the bet, then resend the identical request.')
  if (e === 'LockServiceUnavailable') return mk('retry', 'The relay cannot take bets right now (its lock service is down). Nothing was submitted.', 'Resend the identical request later.', { wait: 30 })
  if (e === 'RpcError') return mk('retry', 'The relay could not reach the chain. Nothing was submitted.', 'Resend the identical request in a few seconds.', { wait: 5 })
  if (e === 'RelayNotConfigured') return mk('retry', 'The relay is misconfigured. Nothing was submitted.', 'Resend the identical request later; give up if it persists.', { wait: 60 })
  if (e === 'RelayUnderfunded') return mk('retry', 'The relay is low on gas money. Nothing was submitted.', 'Resend the identical request later while the authorization is valid.', { wait: 120 })
  if (e === 'MarketPaused') return mk('retry', 'The owner paused this market.', 'Resend the identical request later while the authorization is valid; otherwise give up.', { wait: 60 })
  if (e === 'BettingIsClosed') return mk('stop', 'Betting on this market has closed.', 'Give up on this market.')
  if (e === 'MarketEnded') return mk('stop', 'This market is settled or canceled.', 'Give up on this market.')
  if (e === 'MarketFull') return mk('stop', 'This market reached its 1,000-bet cap.', 'Give up on this market.')
  if (e === 'FeeTransferFailed') return mk('stop', 'This market cannot take bets (its owner cannot receive USDC).', 'Give up and report it.')
  if (e === 'UnsupportedMarket') return mk('stop', 'The relay only handles markets created by Factory v1.6.', 'Give up on this market.')
  if (e === 'MarketNotFound') return mk('stop', 'The relay does not know this market.', 'Rediscover open markets with the markets command.')
  if (e === 'BadAuthorizationNonce') return mk('resign', 'The nonce did not match the salt and side.', 'Start over with a fresh prepare.')
  if (e === 'BelowMinBet') return mk('resign', 'The stake is under 1 USDC.', 'Raise the stake and prepare again.')
  if (e === 'AuthorizationExpired') return mk('resign', 'The authorization has expired.', 'Prepare and confirm again.')
  if (e === 'InvalidBettor' || e === 'InvalidRequest') return mk('stop', `The relay rejected the request (${e}${body?.field ? `, field ${body.field}` : ''}).`, 'Give up and report it.')
  if (e === 'SimulationReverted') return mk('stop', `The bet would revert (${body.errorName || body.reason || 'unknown'}).`, 'Give up and report the error name.')
  if (e === 'AuthorizationRejected') {
    if (r === 'InsufficientUsdcBalance') return mk('retry', 'The wallet does not hold enough USDC for stake plus fee.', 'Fund the wallet with at least the total, then resend the identical request.', { wait: 30 })
    if (r === 'AuthorizationUsedOrCanceled') return mk('status', 'USDC says this authorization was already used.', 'Check the chain; if no bet exists, prepare again with a fresh salt.')
    if (r === 'AuthorizationNotYetValid') return mk('retry', 'The authorization is not valid yet.', 'Resend the identical request shortly.', { wait: 10 })
    if (r === 'UsdcPaused') return mk('retry', 'USDC itself is paused.', 'Resend the identical request later.', { wait: 300 })
    if (r === 'AccountBlacklisted') return mk('stop', 'Circle has blacklisted an account on this transfer.', 'Give up.')
    return mk('resign', `USDC refused the signature (${r || 'InvalidSignature'}).`, 'Prepare and confirm again.')
  }
  return mk('stop', `Unexpected answer from the relay (HTTP ${status}${e ? `, ${e}` : ''}).`, 'Give up and report it.')
}
export function explainClaimError(status, body) {
  const e = body?.error || ''
  const mk = (line, action) => ({ line, action })
  const t = {
    RateLimited: mk('Too many requests from this IP.', `Retry after ${body?.retryAfterSeconds ?? 60} seconds.`),
    InvalidRequest: mk('The request was malformed.', 'Report it.'),
    InvalidBettor: mk('The wallet address is not valid.', 'Report it.'),
    MarketNotFound: mk('The relay does not know this market.', 'Check the market address.'),
    UnsupportedMarket: mk('This market is from an older factory, so the relay cannot claim for it.', 'Claim directly with claimPayout or claimAllPayouts, which needs a little ETH.'),
    ClaimInFlight: mk('A claim for this market was sent in the last 60 seconds.', 'Check your USDC balance, then retry after the lock if bets remain.'),
    RelayBusy: mk('The relay was busy with another bet.', `Retry after ${body?.retryAfterSeconds ?? 10} seconds.`),
    LockServiceUnavailable: mk('The relay cannot take claims right now.', 'Retry later, or claim directly with a little ETH.'),
    RpcError: mk('The relay could not reach the chain.', 'Retry in a few seconds.'),
    RelayNotConfigured: mk('The relay is misconfigured.', 'Retry later, or claim directly with a little ETH.'),
    RelayUnderfunded: mk('The relay is low on gas money.', 'Retry later, or claim directly with a little ETH.'),
    SubmissionFailed: mk('The relay could not send the transaction.', 'Retry after the 60-second lock.'),
    SubmissionPending: mk(`The claim was sent but not mined yet${body?.txHash ? ` (${body.txHash})` : ''}.`, 'Check the transaction; retry after the 60-second lock if it never lands.'),
    SubmissionReverted: mk(`The claim reverted${body?.txHash ? ` (${body.txHash})` : ''}. Nothing moved.`, 'Retry once; if it reverts again, claim directly with a little ETH.'),
    CustodyInvariantViolated: mk(`The relay's receipt check failed${body?.txHash ? ` (${body.txHash})` : ''}.`, 'Stop and report the transaction hash to evenstevenbet@gmail.com.'),
    InternalError: mk('Unexpected server error.', 'Check your balance, then retry.'),
  }
  if (t[e]) return t[e]
  if (status === 409 && e) return mk(`The market rejected the claim (${e}).`, 'Retry once; "Nothing claimable" afterwards means the money already reached you.')
  return mk(`Unexpected answer from the relay (HTTP ${status}${e ? `, ${e}` : ''}).`, 'Report it.')
}

// ---- the CLI --------------------------------------------------------------------------------
export function createCli(deps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const fetchImpl = deps.fetchImpl ?? fetch
  const pc = deps.publicClient ?? createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL || 'https://mainnet.base.org') })
  const randomSalt = deps.randomSalt ?? (() => '0x' + crypto.randomBytes(32).toString('hex'))
  const randomId = deps.randomId ?? (() => crypto.randomBytes(4).toString('hex'))
  const factory = deps.factory ?? FACTORY   // tests only: the fork test deploys its own v1.6 factory
  const stateDir = deps.stateDir ?? env.ES_STATE_DIR ?? path.join(os.homedir(), '.bankr', 'even-steven')
  const configPath = deps.configPath ?? env.BANKR_CONFIG ?? path.join(os.homedir(), '.bankr', 'config.json')
  const maxStake = env.ES_MAX_STAKE ?? DEFAULT_MAX_STAKE
  const ref = env.ES_REF || undefined
  let apiKey = null
  const lines = []
  const log = deps.log ?? ((l) => console.log(l))
  const out = (...a) => { let t = a.join(' '); if (apiKey) t = t.split(apiKey).join('[REDACTED]'); lines.push(t); log(t) }

  function loadKey() {
    if (apiKey) return apiKey
    if (!fs.existsSync(configPath)) throw new UserError(`Bankr config not found at ${configPath}. Run \`bankr login email <your-email>\` and create a read-write key.`)
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    apiKey = cfg.apiKey || cfg.api_key
    if (!apiKey) throw new UserError(`No apiKey in ${configPath}.`)
    return apiKey
  }
  async function call(base_, method, p, body) {
    const url = base_ + p
    if (!url.startsWith(API_BASE + '/') && !url.startsWith(BANKR_API + '/')) throw new Error('refusing to call an unpinned host')
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (base_ === BANKR_API) headers['X-API-Key'] = loadKey()
    const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text }
  }
  async function getWallet() {
    const r = await call(BANKR_API, 'GET', '/wallet/me')
    if (!r.ok) throw new UserError(`Bankr GET /wallet/me failed (HTTP ${r.status}). Check the key in ${configPath}.`)
    const evm = (r.json?.wallets || []).find((w) => w.chain === 'evm')
    if (!evm || !isAddress(evm.address)) throw new UserError('Bankr returned no EVM wallet address.')
    return getAddress(evm.address)
  }
  const marketBlurb = (m) => `${m.home} (home) vs ${m.away} (away)`
  const intentPath = (id) => path.join(stateDir, 'intents', `${id}.json`)
  function saveIntent(i) {
    fs.mkdirSync(path.join(stateDir, 'intents'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(intentPath(i.id), JSON.stringify(i, null, 2), { mode: 0o600 })
  }
  function loadIntent(id) {
    if (!/^[a-f0-9]{8}$/.test(id || '')) throw new UserError('That is not a valid intent id. Run bet --prepare first.')
    if (!fs.existsSync(intentPath(id))) throw new UserError('No prepared bet with that id. Run bet --prepare first; a bet cannot be confirmed without it.')
    return JSON.parse(fs.readFileSync(intentPath(id), 'utf8'))
  }
  async function factoryHasMarket(addr) {
    const gid = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'gameIdByMarket', args: [addr] })
    return !!gid
  }
  const readFee = (addr) => pc.readContract({ address: addr, abi: MARKET_ABI, functionName: 'FEE_PERCENT' })
  async function betsOf(market, wallet) {
    const ids = await pc.readContract({ address: market, abi: MARKET_ABI, functionName: 'getBetsByAddress', args: [wallet] })
    const bets = await Promise.all(ids.map((id) => pc.readContract({ address: market, abi: MARKET_ABI, functionName: 'getBet', args: [id] }).then((b) => ({ id, ...b }))))
    return bets
  }

  // ---- markets ----
  async function cmdMarkets(all = false) {
    const ms = await listMarkets(pc, all ? 'all' : 'open', factory)
    if (!ms.length) { out(all ? 'No markets yet.' : 'No open markets right now.'); return 0 }
    out(all ? `Recent markets (${ms.length}, open or not):` : `Open markets (${ms.length}):`)
    for (const m of ms) {
      out(`- ${m.gameId}`)
      out(`  ${marketBlurb(m)}. Line: ${favoriteHeadline(m.z, m.home, m.away)} (z ${Number(m.z) / 10_000}, home perspective)`)
      out(`  Pools: home ${usd(m.gPool)} USDC, away ${usd(m.lePool)} USDC, total ${usd(m.tPool)} USDC (pools include the protocol seed). Betting ${m.isOpen ? 'open' : 'closed'}.`)
      out(`  Market: ${m.address}`)
    }
    return 0
  }

  // ---- odds ----
  async function cmdOdds(queryWords, stakeText, all = false) {
    const ms = await listMarkets(pc, all ? 'all' : 'open', factory)
    const r = matchMarket(queryWords, ms)
    if (r.none) { out(`No ${all ? '' : 'open '}market matches "${queryWords}". Run the markets command to see what is open.`); return 3 }
    if (r.ambiguous) { out(`More than one open market matches "${queryWords}". Ask the user which one:`); r.ambiguous.forEach((m) => out(`- ${m.gameId}`)); return 3 }
    const m = r.match
    const stake = parseStake(stakeText ?? '10', maxStake)
    out(`${marketBlurb(m)}  [${m.gameId}]`)
    out(`Line: ${favoriteHeadline(m.z, m.home, m.away)}. Betting ${m.isOpen ? 'open' : 'closed'}. The line moves as bets arrive; a bet locks the line in force when it lands.`)
    out(`Pools: home ${usd(m.gPool)} USDC, away ${usd(m.lePool)} USDC.`)
    for (const [side, gt] of [['home', true], ['away', false]]) {
      const [cur, liq, vig] = await pc.readContract({ address: m.address, abi: MARKET_ABI, functionName: 'getMarketEV', args: [stake, gt] })
      out(`${lineSentence(m.z, side, m.home, m.away)}`)
      out(`  For a ${usd(stake)} USDC stake (gross, before the ${Number(vig) / 100}% fee paid upfront): ${usd(cur)} USDC if betting closed with the pools as they are now; ${usd(liq)} USDC when the two pools are balanced (even money). The payout is set at settlement from the final pool.`)
    }
    return 0
  }

  // ---- bet --prepare ----
  async function cmdPrepare(game, sideText, stakeText) {
    const stake = parseStake(stakeText, maxStake)
    const wallet = await getWallet()
    const ms = await listMarkets(pc, 'open', factory)
    const r = matchMarket(game, ms)
    if (r.none) { out(`No open market matches "${game}". Run the markets command to see what is open.`); return 3 }
    if (r.ambiguous) { out(`More than one open market matches "${game}". Ask the user which one, then prepare again:`); r.ambiguous.forEach((m) => out(`- ${m.gameId}`)); return 3 }
    const m = r.match
    if (!m.isOpen) { out('Betting on that market is closed.'); return 1 }
    const s = parseSide(sideText, m)
    if (!s) { out(`Which side? "${sideText}" does not clearly mean ${m.home} (home) or ${m.away} (away). Ask the user, then prepare again.`); return 3 }
    if (!(await factoryHasMarket(m.address))) { out('That market was not created by Factory v1.6. Not betting.'); return 1 }
    const feeBps = await readFee(m.address)
    const fee = (stake * feeBps) / 10_000n
    const total = stake + fee
    const id = randomId()
    const t = now()
    saveIntent({ id, state: 'pending', createdAt: t, expiresAt: t + INTENT_TTL, wallet, market: m.address, gameId: m.gameId,
                 side: s.side, greaterThan: s.greaterThan, stake: stake.toString(), feeBps: feeBps.toString(), fee: fee.toString(), total: total.toString() })
    const pct = Number(feeBps) / 100
    out('Confirm this bet?')
    out(`Game: ${marketBlurb(m)}`)
    out(`Your pick: ${lineSentence(m.z, s.side, m.home, m.away)}`)
    out('1. Even money: back either side at even money. The spread moves to balance the pool, and a balanced pool pays even money. Your payout is set at settlement from the final pool.')
    out(`2. The early line: this line locks when your bet lands and never changes. Later bets move the line for later bettors. Current line: ${favoriteHeadline(m.z, m.home, m.away)}.`)
    out(`3. Cost: a flat ${pct}% fee on your stake, paid upfront. Stake ${usd(stake)} USDC + fee ${usd(fee)} USDC = total ${usd(total)} USDC from your Bankr wallet.`)
    out(`Intent id: ${id} (valid for 5 minutes)`)
    out('Reply confirm.')
    return 0
  }

  // ---- bet --confirm ----
  function buildAuthorization({ wallet, market, stake, fee, greaterThan, salt, t }) {
    const td = {
      domain: { ...DOMAIN },
      types: structuredClone(RWA_TYPES),
      primaryType: 'ReceiveWithAuthorization',
      message: { from: wallet, to: market, value: (stake + fee).toString(), validAfter: '0', validBefore: String(t + VALID_WINDOW), nonce: deriveNonce(salt, greaterThan) },
    }
    return td
  }
  /** Every check runs on the exact object that will be sent to /wallet/sign. Throws UserError on failure. */
  async function preSignChecks({ td, wallet, stake, greaterThan, salt, t }) {
    const fail = (why) => { throw new UserError(`Aborted before signing: ${why}`) }
    const d = td.domain
    if (d.name !== DOMAIN.name || d.version !== DOMAIN.version || d.chainId !== DOMAIN.chainId || d.verifyingContract !== DOMAIN.verifyingContract
        || Object.keys(d).length !== 4) fail('the signing domain is not exactly USDC on Base.')
    if (td.primaryType !== 'ReceiveWithAuthorization' || Object.keys(td.types).length !== 1 || !td.types.ReceiveWithAuthorization) fail('the typed data is not exactly a ReceiveWithAuthorization.')
    const m = td.message
    for (const k of ['value', 'validAfter', 'validBefore']) if (typeof m[k] !== 'string' || !/^\d+$/.test(m[k])) fail(`${k} must be a decimal string.`)
    if (!isAddress(m.to) || !(await factoryHasMarket(getAddress(m.to)))) fail('the recipient is not a market created by Factory v1.6.')
    const feeBps = await readFee(getAddress(m.to))
    if (BigInt(m.value) !== stake + (stake * feeBps) / 10_000n) fail('the value is not stake plus the market\'s fee.')
    if (!isAddress(m.from) || getAddress(m.from) !== getAddress(wallet)) fail('the signer is not your Bankr wallet.')
    if (m.validAfter !== '0') fail('validAfter must be 0.')
    if (BigInt(m.validBefore) !== BigInt(t + VALID_WINDOW)) fail('validBefore must be now plus 10 minutes.')
    if (!/^0x[0-9a-f]{64}$/i.test(salt) || m.nonce !== deriveNonce(salt, greaterThan)) fail('the nonce is not keccak256(salt, side).')
    if (stake < MIN_STAKE) fail('the stake is under 1 USDC.')
    if (stake > BigInt(Math.round(Number(maxStake) * 1e6))) fail('the stake is over the maximum.')
  }
  async function verifySignature({ wallet, td, signature }) {
    const mm = td.message
    const digest = hashTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
      message: { ...mm, value: BigInt(mm.value), validAfter: BigInt(mm.validAfter), validBefore: BigInt(mm.validBefore) } })
    if (!/^0x[0-9a-fA-F]*$/.test(signature)) return { ok: false, why: 'the signature is not hex' }
    if (size(signature) === 65) {
      try { return { ok: getAddress(await recoverAddress({ hash: digest, signature })) === getAddress(wallet), how: 'ecrecover' } }
      catch { return { ok: false, why: 'the signature cannot be recovered' } }
    }
    const code = await pc.getCode({ address: wallet })
    if (!code || code === '0x') return { ok: false, why: 'a non-65-byte signature from an account with no code' }
    try {
      const ret = await pc.readContract({ address: wallet, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })
      return { ok: ret.toLowerCase() === MAGIC_1271, how: 'erc1271' }
    } catch { return { ok: false, why: 'the wallet rejected the signature (ERC-1271)' } }
  }
  function betSuccess(intent, body, m) {
    const z = BigInt(body.lockedZ ?? '0')
    const mk = m ?? parseGameId(intent.gameId)
    out(`Bet placed. ${lineSentence(z, intent.side, mk.home, mk.away)}`)
    out(`Your line locked at ${body.lockedZDisplay ?? Number(z) / 10_000} and does not change; later bets move the line for later bettors.`)
    out(`Stake ${usd(intent.stake)} USDC + fee ${usd(body.fee ?? intent.fee)} USDC. Your payout is set at settlement from the final pool.`)
    out(`Bet id ${body.betId}. Transaction: ${BASESCAN}/tx/${body.txHash}`)
  }
  const relayPayload = (i) => i.payload
  async function postBet(intent) {
    const r = await call(API_BASE, 'POST', '/api/bet', relayPayload(intent))
    intent.attempts = (intent.attempts || 0) + 1
    intent.lastSubmitAt = now()
    if (r.ok && r.json?.success) {
      intent.state = 'done'; intent.result = r.json; saveIntent(intent)
      betSuccess(intent, r.json)
      return 0
    }
    const ex = explainBetError(r.status, r.json)
    intent.state = 'signed'; intent.lastError = { kind: ex.kind, error: r.json?.error, status: r.status, wait: ex.wait }
    if (ex.kind === 'stop' || ex.kind === 'resign') intent.state = 'failed'
    saveIntent(intent)
    out(`The bet was not placed: ${ex.line}`)
    out(`What to do: ${ex.action}`)
    if (ex.kind === 'retry') out(`To retry, run: bet --confirm ${intent.id} (it resends the identical request, no new signature).`)
    if (ex.kind === 'status') out(`Next, run: bet --confirm ${intent.id} (it checks the chain first and never re-signs).`)
    if (ex.kind === 'resign') out('Run bet --prepare again and have the user confirm again.')
    return 1
  }
  async function cmdConfirm(id) {
    const intent = loadIntent(id)
    const t = now()
    if (intent.state === 'done') { out('That bet was already placed. Nothing to do.'); if (intent.result) betSuccess(intent, intent.result); return 1 }
    if (intent.state === 'failed' || intent.state === 'abandoned') { out('That prepared bet is finished and cannot be confirmed again. Run bet --prepare for a new one.'); return 1 }
    if (intent.state === 'signed') return resume(intent, t)
    if (intent.state !== 'pending') { out('That prepared bet cannot be confirmed.'); return 1 }
    if (t > intent.expiresAt) { intent.state = 'failed'; saveIntent(intent); out('That prepared bet expired (5 minutes). Run bet --prepare again.'); return 1 }

    // Re-read and re-validate everything before signing.
    const wallet = await getWallet()
    if (getAddress(wallet) !== getAddress(intent.wallet)) { out('The Bankr wallet changed since prepare. Run bet --prepare again.'); return 1 }
    const market = getAddress(intent.market)
    const st = await readMarket(pc, market)
    if (!st.isOpen) { out('Betting on that market has closed. Nothing was signed.'); return 1 }
    const feeBps = await readFee(market)
    if (feeBps.toString() !== intent.feeBps) { out('The market\'s fee changed since prepare. Nothing was signed. Run bet --prepare again.'); return 1 }
    const stake = BigInt(intent.stake), fee = BigInt(intent.fee)
    const salt = randomSalt()
    const td = buildAuthorization({ wallet, market, stake, fee, greaterThan: intent.greaterThan, salt, t })
    await preSignChecks({ td, wallet, stake, greaterThan: intent.greaterThan, salt, t })

    const betsBefore = (await betsOf(market, wallet)).length
    const sign = await call(BANKR_API, 'POST', '/wallet/sign', { signatureType: 'eth_signTypedData_v4', typedData: td })
    if (sign.status === 403) {
      out('Bankr refused to sign (HTTP 403). Body verbatim:')
      out(sign.text)
      out('This Bankr key restricts typed-data signing, for example because Trusted Addresses (allowed recipients) are set or the key is read-only. Even Steven bets need an EIP-712 signature. In bankr.bot/api-keys, use a key with Wallet API enabled, Read Only off, and no Trusted Addresses, then try again.')
      return 2
    }
    if (!sign.ok || !sign.json?.success || typeof sign.json.signature !== 'string') {
      out(`Bankr could not sign (HTTP ${sign.status}). Nothing was sent. Body:`); out(sign.text); return 1
    }
    const { signature, signer } = sign.json
    if (!signer || !isAddress(signer) || getAddress(signer) !== getAddress(wallet)) { out('Aborted: the signer Bankr returned is not your wallet. Nothing was sent.'); return 1 }
    const v = await verifySignature({ wallet, td, signature })
    if (!v.ok) { out(`Aborted: the signature does not verify for your wallet (${v.why || 'mismatch'}). Nothing was sent.`); return 1 }

    const payload = { marketAddress: market, bettor: wallet, greaterThan: intent.greaterThan, stake: stake.toString(),
      validAfter: '0', validBefore: td.message.validBefore, nonce: td.message.nonce, salt, signature }
    if (ref) payload.ref = ref
    Object.assign(intent, { state: 'signed', payload, betsBefore, signedAt: t, validBefore: Number(td.message.validBefore), attempts: 0 })
    saveIntent(intent)
    return postBet(intent)
  }
  /** A signed intent is being confirmed again: follow the relay's retry rule. */
  async function resume(intent, t) {
    const le = intent.lastError || {}
    const wallet = getAddress(intent.wallet), market = getAddress(intent.market)
    if (le.kind === 'retry') {
      if (intent.validBefore - t <= 40) { intent.state = 'abandoned'; saveIntent(intent); out('The signed authorization is about to expire, so it cannot be resent. Nothing was placed. Run bet --prepare for a new bet.'); return 1 }
      return postBet(intent)
    }
    // status path: look at the chain first, never re-sign.
    const bets = await betsOf(market, wallet)
    const landed = bets.length > intent.betsBefore
    if (landed) {
      const b = bets[bets.length - 1]
      intent.state = 'done'; intent.result = { betId: String(b.id), lockedZ: b.lockedZ.toString(), lockedZDisplay: String(Number(b.lockedZ) / 10_000), fee: intent.fee, txHash: le.txHash || '(see the market on BaseScan)' }
      saveIntent(intent)
      out('The bet did land.')
      out(`${lineSentence(b.lockedZ, intent.side, parseGameId(intent.gameId).home, parseGameId(intent.gameId).away)}`)
      out(`Your line locked at ${Number(b.lockedZ) / 10_000}. Bet id ${b.id}. Market: ${BASESCAN}/address/${market}`)
      return 0
    }
    const sinceSubmit = t - (intent.lastSubmitAt || 0)
    if (sinceSubmit < SUBMIT_LOCK) { out(`No bet has landed yet. The relay holds this authorization for ${SUBMIT_LOCK - sinceSubmit} more seconds. Do not re-sign. Check again after that.`); return 1 }
    if (intent.validBefore - t > 40 && (intent.attempts || 0) < 3) { out('No bet landed and the lock has passed, so the identical request is resent (no new signature).'); return postBet(intent) }
    intent.state = 'abandoned'; saveIntent(intent)
    out('No bet landed and the authorization has expired, so it can never be used. Nothing was spent. Run bet --prepare for a new bet.')
    return 1
  }

  // ---- status ----
  async function cmdStatus(game) {
    const wallet = await getWallet()
    const ms = await listMarkets(pc, 'all', factory)
    const r = matchMarket(game, ms)
    if (r.none) { out(`No market matches "${game}".`); return 3 }
    if (r.ambiguous) { out(`More than one market matches "${game}". Ask the user which one:`); r.ambiguous.forEach((m) => out(`- ${m.gameId}`)); return 3 }
    const m = r.match
    const bets = await betsOf(m.address, wallet)
    out(`${marketBlurb(m)}  [${m.gameId}]  ${m.isSettled ? 'settled' : m.isOpen ? 'betting open' : 'betting closed'}`)
    if (!bets.length) { out('No bets from your Bankr wallet on this market.'); return 0 }
    for (const b of bets) {
      const side = b.greaterThan ? 'home' : 'away'
      out(`- Bet ${b.id}: ${usd(b.stake)} USDC. ${lineSentence(b.lockedZ, side, m.home, m.away)}. ${b.claimed ? 'Claimed.' : 'Not claimed.'}`)
    }
    return 0
  }

  // ---- claim ----
  async function cmdClaim(game) {
    const wallet = await getWallet()
    const ms = await listMarkets(pc, 'all', factory)
    const r = matchMarket(game, ms)
    if (r.none) { out(`No market matches "${game}".`); return 3 }
    if (r.ambiguous) { out(`More than one market matches "${game}". Ask the user which one:`); r.ambiguous.forEach((m) => out(`- ${m.gameId}`)); return 3 }
    const m = r.match
    const res = await call(API_BASE, 'POST', '/api/claim', { marketAddress: m.address, bettor: wallet })
    let code = 0
    if (res.ok && res.json && (res.json.success || res.json.note)) {
      const j = res.json
      if (j.success) {
        out(`Claimed ${j.claimedCount} bet(s) on ${m.gameId}: ${usd(j.amount)} USDC paid to your wallet.`)
        for (const h of j.txHashes || []) out(`Transaction: ${BASESCAN}/tx/${h}`)
        if (j.remainingCount > 0) out(`${j.remainingCount} more bet(s) remain. Run claim again.`)
        if (j.incomplete) { out(`Stopped early: ${j.incomplete.message || j.incomplete.error}`); code = 1 }
      } else out('Nothing claimable on that market: the market is not settled yet, the bets lost, or they are already claimed.')
    } else {
      const ex = explainClaimError(res.status, res.json)
      out(`The claim did not go through: ${ex.line}`); out(`What to do: ${ex.action}`); code = 1
    }
    out(CLAIM_SENTENCE)
    return code
  }

  async function run(argv) {
    try {
      const [cmd, ...rest] = argv
      if (cmd === 'markets') return await cmdMarkets(rest.includes('--all'))
      if (cmd === 'odds') {
        const si = rest.indexOf('--stake'); const stakeText = si >= 0 ? rest[si + 1] : undefined
        const all = rest.includes('--all')
        const words = rest.filter((w, i) => w !== '--all' && (si < 0 || (i !== si && i !== si + 1))).join(' ')
        if (!words) throw new UserError('Usage: odds "<game>" [--stake 10]')
        return await cmdOdds(words, stakeText, all)
      }
      if (cmd === 'bet') {
        if (rest[0] === '--prepare') {
          if (rest.length !== 4) throw new UserError('Usage: bet --prepare "<game>" <side> <stake>')
          return await cmdPrepare(rest[1], rest[2], rest[3])
        }
        if (rest[0] === '--confirm') {
          if (rest.length !== 2) throw new UserError('Usage: bet --confirm <intent-id>')
          return await cmdConfirm(rest[1])
        }
        throw new UserError('A bet takes two steps: bet --prepare "<game>" <side> <stake>, then, after the user replies confirm, bet --confirm <intent-id>.')
      }
      if (cmd === 'status') return await cmdStatus(rest.join(' '))
      if (cmd === 'claim') return await cmdClaim(rest.join(' '))
      throw new UserError('Commands: markets | odds "<game>" [--stake N] | bet --prepare "<game>" <side> <stake> | bet --confirm <id> | status "<game>" | claim "<game>"')
    } catch (e) {
      if (e instanceof UserError) { out(e.message); return 1 }
      const msg = String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '[url]')
      out(`Error: ${msg}`)
      return 1
    }
  }
  return { run, lines, preSignChecks, buildAuthorization }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cli = createCli()
  process.exitCode = await cli.run(process.argv.slice(2))
}
