// Core logic of the Even Steven MCP server. It holds no keys and signs nothing: prepare_bet returns typed data
// for the CLIENT's wallet to sign, and submit_bet re-derives every field from the submitted payload, verifies the
// signature, and only then posts it to the relay. Everything external (chain reads, HTTP, clock, randomness)
// is injected so the unit tests need no network.
import { getAddress, isAddress, hashTypedData, recoverAddress, size } from 'viem'
import { randomBytes } from 'node:crypto'
import {
  FACTORY, API_BASE, BASESCAN, DOMAIN, RWA_TYPES, MIN_STAKE, DEFAULT_MAX_STAKE, VALID_WINDOW, MAGIC_1271, CLAIM_SENTENCE,
  FACTORY_ABI, MARKET_ABI, ERC1271_ABI, usd, parseStake, deriveNonce, lineSentence, favoriteHeadline, parseGameId, readMarket, listMarkets,
  matchMarket, parseSide, explainBetError, explainClaimError, UserError,
} from './shared.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const str = (x) => (typeof x === 'bigint' ? x.toString() : x)

export function createCore({ publicClient: pc, factory = FACTORY, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000),
  randomSalt = () => '0x' + randomBytes(32).toString('hex'), maxStake = DEFAULT_MAX_STAKE, apiBase = API_BASE } = {}) {

  const marketView = (m) => ({
    marketAddress: m.address, gameId: m.gameId, home: m.home, away: m.away, date: m.date,
    line: favoriteHeadline(m.z, m.home, m.away), currentZ: str(m.z), currentZDisplay: String(Number(m.z) / 10_000),
    homePool: str(m.gPool), awayPool: str(m.lePool), totalPool: str(m.tPool), isOpen: m.isOpen, isSettled: m.isSettled,
  })
  const factoryHasMarket = async (addr) => !!(await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'gameIdByMarket', args: [addr] }))
  const readFee = (addr) => pc.readContract({ address: addr, abi: MARKET_ABI, functionName: 'FEE_PERCENT' })

  /** Resolve words, a gameId or a market address. Returns { match } | { ask } | { error }. */
  async function resolve(query, scope) {
    const q = String(query ?? '').trim()
    if (!q) return { error: 'No game given.' }
    if (isAddress(q)) {
      const a = getAddress(q)
      if (!(await factoryHasMarket(a))) return { error: `${a} was not created by Factory v1.6.` }
      return { match: await readMarket(pc, a) }
    }
    if (/^[A-Z0-9]+-\d{4}-\d{2}-\d{2}-HOME-.+-AWAY-.+$/.test(q)) {
      const a = await pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'marketByGameId', args: [q] })
      if (a && a !== ZERO) return { match: await readMarket(pc, getAddress(a)) }
    }
    const r = matchMarket(q, await listMarkets(pc, scope, factory))
    if (r.match) return { match: r.match }
    if (r.ambiguous) return { ask: `More than one market matches "${q}". Ask the user which one.`, options: r.ambiguous.map(marketView) }
    return { error: `No ${scope === 'open' ? 'open ' : ''}market matches "${q}".` }
  }

  async function listMarketsTool({ all = false } = {}) {
    const ms = await listMarkets(pc, all ? 'all' : 'open', factory)
    return { markets: ms.map(marketView), note: ms.length ? undefined : (all ? 'No markets yet.' : 'No open markets right now.') }
  }

  async function getQuote({ game, stake = '10', all = false }) {
    const r = await resolve(game, all ? 'all' : 'open')
    if (r.error) return { error: r.error }
    if (r.ask) return { ask: r.ask, options: r.options }
    const m = r.match, s = parseStake(String(stake), maxStake)
    const sides = []
    for (const [side, gt] of [['home', true], ['away', false]]) {
      const [cur, liq, vig] = await pc.readContract({ address: m.address, abi: MARKET_ABI, functionName: 'getMarketEV', args: [s, gt] })
      sides.push({ side, team: side === 'home' ? m.home : m.away, pick: lineSentence(m.z, side, m.home, m.away), stake: s.toString(),
        currentPayoutGross: cur.toString(), balancedPoolPayoutGross: liq.toString(), feeBps: vig.toString() })
    }
    return { market: marketView(m), sides,
      note: 'Payouts are gross, before the flat fee paid upfront. currentPayoutGross is what the side would return if betting closed with the pools as they are now; balancedPoolPayoutGross is the payout when the two pools are balanced (even money). The payout is set at settlement from the final pool.' }
  }

  /** The typed data the client's wallet must sign, derived from these fields only. */
  function buildTypedData({ bettor, market, value, validBefore, nonce }) {
    return { domain: { ...DOMAIN }, types: structuredClone(RWA_TYPES), primaryType: 'ReceiveWithAuthorization',
      message: { from: bettor, to: market, value: String(value), validAfter: '0', validBefore: String(validBefore), nonce } }
  }

  async function prepareBet({ game, side, stake, bettor }) {
    if (!isAddress(bettor ?? '') || getAddress(bettor) === ZERO) return { error: 'bettor must be the address of the wallet that will sign.' }
    const who = getAddress(bettor)
    const s = parseStake(String(stake), maxStake)
    const r = await resolve(game, 'open')
    if (r.error) return { error: r.error }
    if (r.ask) return { ask: r.ask, options: r.options }
    const m = r.match
    if (!m.isOpen) return { error: 'Betting on that market is closed.' }
    const sd = parseSide(side, m)
    if (!sd) return { ask: `Which side? "${side}" does not clearly mean ${m.home} (home) or ${m.away} (away). Ask the user.` }
    if (!(await factoryHasMarket(m.address))) return { error: 'That market was not created by Factory v1.6.' }
    const feeBps = await readFee(m.address)
    const fee = (s * feeBps) / 10_000n, total = s + fee
    const t = now(), validBefore = t + VALID_WINDOW
    const salt = randomSalt()
    const nonce = deriveNonce(salt, sd.greaterThan)
    const typedData = buildTypedData({ bettor: who, market: m.address, value: total, validBefore, nonce })
    const pct = Number(feeBps) / 100
    return {
      status: 'ready',
      market: marketView(m), side: sd.side, pick: lineSentence(m.z, sd.side, m.home, m.away),
      stake: s.toString(), fee: fee.toString(), total: total.toString(), validBefore,
      confirmationText: [
        `Your pick: ${lineSentence(m.z, sd.side, m.home, m.away)}.`,
        '1. Even money: back either side at even money. The spread moves to balance the pool, and a balanced pool pays even money. Your payout is set at settlement from the final pool.',
        `2. The early line: this line locks when your bet lands and never changes. Later bets move the line for later bettors. Current line: ${favoriteHeadline(m.z, m.home, m.away)}.`,
        `3. Cost: a flat ${pct}% fee on your stake, paid upfront. Stake ${usd(s)} USDC + fee ${usd(fee)} USDC = total ${usd(total)} USDC from ${who}.`,
        'Ask the user to confirm before signing.',
      ].join('\n'),
      typedData,
      relayPayload: { marketAddress: m.address, bettor: who, greaterThan: sd.greaterThan, stake: s.toString(), validAfter: '0',
        validBefore: String(validBefore), nonce, salt },
      next: 'Show confirmationText to the user. After they confirm, have the wallet that owns `bettor` sign `typedData` with eth_signTypedData_v4, then call submit_bet with relayPayload plus the signature. The server never signs and never sees a key.',
    }
  }

  /** Everything submit_bet checks, from the payload alone. Throws UserError with the reason. */
  async function verifyPayload(p) {
    const fail = (why) => { throw new UserError(`Not submitted: ${why}`) }
    const known = ['marketAddress', 'bettor', 'greaterThan', 'stake', 'validAfter', 'validBefore', 'nonce', 'salt', 'signature']
    for (const k of Object.keys(p)) if (!known.includes(k)) fail(`unexpected field "${k}".`)
    if (!isAddress(p.marketAddress ?? '')) fail('marketAddress is not an address.')
    if (!isAddress(p.bettor ?? '') || getAddress(p.bettor) === ZERO) fail('bettor is not an address.')
    if (typeof p.greaterThan !== 'boolean') fail('greaterThan must be true (home) or false (away).')
    for (const k of ['stake', 'validAfter', 'validBefore']) if (typeof p[k] !== 'string' || !/^\d+$/.test(p[k])) fail(`${k} must be a decimal string.`)
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.salt ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(p.nonce ?? '')) fail('salt and nonce must be 32-byte hex.')
    if (!/^0x[0-9a-fA-F]+$/.test(p.signature ?? '')) fail('signature must be hex.')
    const market = getAddress(p.marketAddress), bettor = getAddress(p.bettor)
    if (!(await factoryHasMarket(market))) fail('marketAddress is not a market created by Factory v1.6.')
    const st = await readMarket(pc, market)
    if (!st.isOpen) fail('betting on that market is closed.')
    const stake = BigInt(p.stake)
    if (stake < MIN_STAKE) fail('the stake is under 1 USDC.')
    if (stake > BigInt(Math.round(Number(maxStake) * 1e6))) fail(`the stake is over this server's maximum of ${maxStake} USDC.`)
    if (p.validAfter !== '0') fail('validAfter must be 0.')
    const t = now(), vb = BigInt(p.validBefore)
    if (vb <= BigInt(t + 30)) fail('the authorization expires in under 30 seconds or has expired. Prepare again.')
    if (vb > BigInt(t + VALID_WINDOW + 60)) fail('validBefore is too far in the future.')
    if (p.nonce.toLowerCase() !== deriveNonce(p.salt, p.greaterThan).toLowerCase()) fail('the nonce is not keccak256(salt, side).')
    const feeBps = await readFee(market)
    const value = stake + (stake * feeBps) / 10_000n
    const td = buildTypedData({ bettor, market, value, validBefore: p.validBefore, nonce: p.nonce })
    const digest = hashTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
      message: { from: bettor, to: market, value, validAfter: 0n, validBefore: vb, nonce: p.nonce } })
    let ok = false
    if (size(p.signature) === 65) {
      try { ok = getAddress(await recoverAddress({ hash: digest, signature: p.signature })) === bettor } catch { ok = false }
    } else {
      const code = await pc.getCode({ address: bettor })
      if (code && code !== '0x') {
        try { ok = (await pc.readContract({ address: bettor, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, p.signature] })).toLowerCase() === MAGIC_1271 } catch { ok = false }
      }
    }
    if (!ok) fail('the signature does not verify for the bettor over the typed data this server derives from your payload. Sign the typedData from prepare_bet exactly.')
    return { market, bettor, st }
  }

  async function submitBet(args) {
    const p = {}
    for (const k of Object.keys(args)) p[k] = args[k]
    const { market, st } = await verifyPayload(p)
    const body = { marketAddress: market, bettor: getAddress(p.bettor), greaterThan: p.greaterThan, stake: p.stake, validAfter: '0',
      validBefore: p.validBefore, nonce: p.nonce, salt: p.salt, signature: p.signature }
    const res = await fetchImpl(`${apiBase}/api/bet`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text(); let j = null; try { j = JSON.parse(text) } catch { /* not json */ }
    if (res.status >= 200 && res.status < 300 && j?.success) {
      const z = BigInt(j.lockedZ ?? '0'), side = p.greaterThan ? 'home' : 'away'
      return { placed: true, betId: j.betId, txHash: j.txHash, txUrl: `${BASESCAN}/tx/${j.txHash}`, lockedZ: j.lockedZ, lockedZDisplay: j.lockedZDisplay,
        lockedLine: lineSentence(z, side, st.home, st.away), stake: j.stake, fee: j.fee,
        note: 'The line locked when the bet landed and does not change. Later bets move the line for later bettors. The payout is set at settlement from the final pool.' }
    }
    const ex = explainBetError(res.status, j)
    return { placed: false, relayStatus: res.status, relayError: j?.error, explanation: ex.line, action: ex.action, class: ex.kind,
      txHash: j?.txHash,
      rule: 'If the class is "retry", call submit_bet again with the identical payload. If it is "status", call get_status first and never sign again. Sign a new authorization only after get_status shows no bet and validBefore has passed.' }
  }

  async function betsOf(market, wallet) {
    const ids = await pc.readContract({ address: market, abi: MARKET_ABI, functionName: 'getBetsByAddress', args: [wallet] })
    return Promise.all(ids.map((id) => pc.readContract({ address: market, abi: MARKET_ABI, functionName: 'getBet', args: [id] }).then((b) => ({ id, ...b }))))
  }

  async function getStatus({ game, bettor }) {
    if (!isAddress(bettor ?? '')) return { error: 'bettor must be an address.' }
    const r = await resolve(game, 'all')
    if (r.error) return { error: r.error }
    if (r.ask) return { ask: r.ask, options: r.options }
    const m = r.match, who = getAddress(bettor)
    const bets = await betsOf(m.address, who)
    return { market: marketView(m), bettor: who, bets: bets.map((b) => ({ betId: b.id.toString(), side: b.greaterThan ? 'home' : 'away', stake: b.stake.toString(),
      lockedZ: b.lockedZ.toString(), pick: lineSentence(b.lockedZ, b.greaterThan ? 'home' : 'away', m.home, m.away), claimed: b.claimed })) }
  }

  async function claim({ game, bettor }) {
    if (!isAddress(bettor ?? '')) return { error: 'bettor must be an address.' }
    const r = await resolve(game, 'all')
    if (r.error) return { error: r.error }
    if (r.ask) return { ask: r.ask, options: r.options }
    const m = r.match, who = getAddress(bettor)
    const res = await fetchImpl(`${apiBase}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ marketAddress: m.address, bettor: who }) })
    const text = await res.text(); let j = null; try { j = JSON.parse(text) } catch { /* not json */ }
    const out = { claimingNote: CLAIM_SENTENCE }
    if (res.ok && j && j.success) return { ...out, claimed: true, claimedCount: j.claimedCount, amount: j.amount, txHashes: j.txHashes, txUrls: (j.txHashes || []).map((h) => `${BASESCAN}/tx/${h}`), remainingCount: j.remainingCount, incomplete: j.incomplete }
    if (res.ok && j && j.note) return { ...out, claimed: false, note: 'Nothing claimable: the market is not settled yet, the bets lost, or they are already claimed.' }
    const ex = explainClaimError(res.status, j)
    return { ...out, claimed: false, relayStatus: res.status, explanation: ex.line, action: ex.action }
  }

  return { listMarkets: listMarketsTool, getQuote, prepareBet, submitBet, getStatus, claim, verifyPayload, resolve }
}
export { UserError }
