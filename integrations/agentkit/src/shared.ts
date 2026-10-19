// @ts-nocheck
// Generated copy of integrations/mcp/src/shared.mjs (run npm run sync). Type checking is off for the copied file.
// Shared helpers, copied from the wallet skill (the sibling bet skill) so this package
// stands alone: pinned addresses, stake parsing, line math, market lookup and the relay error tables.
import { getAddress, isAddress, keccak256, encodeAbiParameters, parseAbi, formatUnits } from 'viem'

// ---- pinned values -------------------------------------------------------------------------
export const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const API_BASE = 'https://evensteven.bet'
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

export const FACTORY_ABI = parseAbi([
  'function getOpenMarkets() view returns (address[])',
  'function getAllMarkets() view returns (address[])',
  'function gameIdByMarket(address) view returns (string)',
  'function marketByGameId(string) view returns (address)',
])
export const MARKET_ABI = parseAbi([
  'function FEE_PERCENT() view returns (uint256)',
  'function getMarketState() view returns (string gameId, int256 z, uint256 gPool, uint256 lePool, uint256 tPool, bool isOpen, bool isSettled)',
  'function getMarketEV(uint256 stake, bool greaterThan) view returns (uint256 currentPayout, uint256 liquidPayout, uint256 impliedVig)',
  'function getBetsByAddress(address) view returns (uint256[])',
  'function getBet(uint256) view returns ((address bettor, uint256 stake, bool greaterThan, int256 lockedZ, bool claimed))',
])
export const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)'])

// ---- small helpers -------------------------------------------------------------------------
export const usd = (n) => (Number(formatUnits(BigInt(n), 6))).toFixed(2)
export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')

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
export async function readMarket(pc, address) {
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

