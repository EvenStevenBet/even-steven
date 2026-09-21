// The differential engine: run an identical call sequence against a v1.10 and a
// v1.11 market and assert everything matches except the four allowed
// difference categories.
import { pub, wallet, pairSend, pairCall, USDC } from './chain.mjs'
import { snapshotMarket, makeNormalizer, diff, logView, j } from './state.mjs'
import { ok, stop } from './report.mjs'
import { keccak256, toHex, decodeEventLog, encodeFunctionData } from 'viem'

export const TOPIC_BETCLAIMED = keccak256(toHex('BetClaimed(address,uint256,uint256)'))
export const TOPIC_SETTLEMENTDETAILS = keccak256(toHex('SettlementDetails(uint256,uint256)'))
export const SEL_MARKETPAUSED = keccak256(toHex('MarketPaused()')).slice(0, 10)
export const SEL_NOTOWNER = keccak256(toHex('NotOwner()')).slice(0, 10)
export const ERR_STRING_SEL = '0x08c379a0'

/** Human-readable form of raw return/revert data, for the evidence log. */
export function describe(d) {
  if (!d) return String(d)
  const h = String(d)
  if (h.startsWith(ERR_STRING_SEL)) {
    try {
      const len = parseInt(h.slice(2 + 8 + 64, 2 + 8 + 128), 16)
      const str = Buffer.from(h.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString('utf8')
      return `${h.slice(0, 10)} Error("${str}")`
    } catch { return h.slice(0, 90) }
  }
  return h.length <= 90 ? h : h.slice(0, 90) + '…'
}

export const ALLOWED = { i: 0, ii: 0, iii: 0, iv: 0 }
export const observed = []   // every observed difference, with its category

function note(cat, what, detail) {
  ALLOWED[cat]++
  observed.push({ cat, what, detail })
}

export class Pair {
  constructor(a, b, actors) {
    this.a = a; this.b = b        // { set, market, abi }
    this.actors = actors
    this.norm = makeNormalizer({
      '<MARKET>':   a.market,   '<MARKET_B>': b.market,
      '<FACTORY>':  a.set.factory, '<FACTORY_B>': b.set.factory,
      '<DEPLOYER>': a.set.deployer, '<DEPLOYER_B>': b.set.deployer,
    })
    // tokenise each side's own addresses to the SAME token so they compare equal
    this.tokensA = { '<MARKET>': a.market, '<FACTORY>': a.set.factory, '<DEPLOYER>': a.set.deployer }
    this.tokensB = { '<MARKET>': b.market, '<FACTORY>': b.set.factory, '<DEPLOYER>': b.set.deployer }
    this._rebuild()
    this.labelsA = { [a.market.toLowerCase()]: 'MARKET', [USDC.toLowerCase()]: 'USDC', [a.set.factory.toLowerCase()]: 'FACTORY' }
    this.labelsB = { [b.market.toLowerCase()]: 'MARKET', [USDC.toLowerCase()]: 'USDC', [b.set.factory.toLowerCase()]: 'FACTORY' }
    this.gas = []
  }

  _rebuild() {
    this.normA = makeNormalizer(this.tokensA)
    this.normB = makeNormalizer(this.tokensB)
  }

  /** Register a value that is legitimately different per deployment (e.g. the UMA
   *  assertionId, which hashes the market address into it) so it compares equal. */
  addToken(name, valueA, valueB) {
    this.tokensA[name] = valueA
    this.tokensB[name] = valueB
    this._rebuild()
  }

  /** Read assertionId() from both markets and tokenise it. */
  async syncAssertionToken() {
    const ia = await pub.readContract({ address: this.a.market, abi: this.a.abi, functionName: 'assertionId' })
    const ib = await pub.readContract({ address: this.b.market, abi: this.b.abi, functionName: 'assertionId' })
    if (ia !== '0x' + '0'.repeat(64)) this.addToken('<ASSERTION_ID>', ia, ib)
    return { ia, ib }
  }

  // viem's `call` takes { to, data } — NOT { address, abi, functionName }. Passing the
  // latter silently executes an empty CREATE and always "succeeds", which would make
  // every revert comparison vacuous.
  _req(side, account, functionName, args) {
    const s = side === 'a' ? this.a : this.b
    return { account, to: s.market, data: encodeFunctionData({ abi: s.abi, functionName, args }) }
  }

  /** Same mutating call on both, in ONE block (identical timestamp/blocknumber). */
  async send(name, account, functionName, args = [], opts = {}) {
    const wa = wallet(account), wb = wallet(account)
    const res = await pairSend(
      () => wa.writeContract({ address: this.a.market, abi: this.a.abi, functionName, args, gas: opts.gas ?? 30000000n }),
      () => wb.writeContract({ address: this.b.market, abi: this.b.abi, functionName, args, gas: opts.gas ?? 30000000n }),
    )
    if (opts.syncTokens) await this.syncAssertionToken()
    return this._compareTx(name, res, functionName)
  }

  /** Mutating call whose ARGS differ per side (e.g. an EIP-3009 authorization,
   *  which is signed against each market's own address). */
  async sendEach(name, account, functionName, argsA, argsB, opts = {}) {
    const wa = wallet(account), wb = wallet(account)
    const res = await pairSend(
      () => wa.writeContract({ address: this.a.market, abi: this.a.abi, functionName, args: argsA, gas: opts.gas ?? 30000000n }),
      () => wb.writeContract({ address: this.b.market, abi: this.b.abi, functionName, args: argsB, gas: opts.gas ?? 30000000n }),
    )
    if (opts.syncTokens) await this.syncAssertionToken()
    return this._compareTx(name, res, functionName)
  }

  /** eth_call whose ARGS differ per side; revert/return data must still match byte for byte. */
  async callEach(name, account, functionName, argsA, argsB, classify = null) {
    const res = await pairCall(this._req('a', account, functionName, argsA),
                               this._req('b', account, functionName, argsB))
    return this._compareCall(name, res, classify)
  }

  /** Same mutating call on a NON-market target (e.g. the factory). */
  async sendTo(name, account, targetA, abiA, targetB, abiB, functionName, args = [], opts = {}) {
    const wa = wallet(account), wb = wallet(account)
    const res = await pairSend(
      () => wa.writeContract({ address: targetA, abi: abiA, functionName, args, gas: opts.gas ?? 30000000n }),
      () => wb.writeContract({ address: targetB, abi: abiB, functionName, args, gas: opts.gas ?? 30000000n }),
    )
    return this._compareTx(name, res, functionName)
  }

  _compareTx(name, res, functionName) {
    const { a, b } = res
    const sa = a.receipt?.status, sb = b.receipt?.status
    if (a.sendError || b.sendError) {
      ok(`${name}: both sides rejected at send`, !!a.sendError === !!b.sendError,
         `a=${a.sendError?.shortMessage || 'ok'} b=${b.sendError?.shortMessage || 'ok'}`)
      return res
    }
    ok(`${name}: same tx status`, sa === sb, `v1.10=${sa} v1.11=${sb}`)
    if (sa !== sb) { stop(`${name}: status diverged`); return res }
    if (sa === 'success') {
      const la = logView(a.receipt, this.normA, this.labelsA)
      const lbRaw = logView(b.receipt, this.normB, this.labelsB)
      const extras = lbRaw.filter(l => l.address === 'MARKET' &&
        [TOPIC_BETCLAIMED, TOPIC_SETTLEMENTDETAILS].includes(l.topics[0]))
      const lb = lbRaw.filter(l => !extras.includes(l))
      if (extras.length) note('i', `${name}: ${extras.length} extra v1.11 log(s)`,
        extras.map(e => e.topics[0] === TOPIC_BETCLAIMED ? 'BetClaimed' : 'SettlementDetails').join(','))
      const same = j(la) === j(lb)
      ok(`${name}: logs identical (excluding allowed v1.11 extras)`, same,
         same ? `${la.length} log(s), +${extras.length} extra` : `\n      v1.10 ${j(la)}\n      v1.11 ${j(lb)}`)
      if (!same) stop(`${name}: log mismatch outside allowed category (i)`)
      const ga = a.receipt.gasUsed, gb = b.receipt.gasUsed
      if (ga !== gb) note('iv', `${name}: gas`, `v1.10=${ga} v1.11=${gb} (+${gb - ga})`)
      this.gas.push({ name: functionName + ' :: ' + name, v110: ga, v111: gb })
    }
    return res
  }

  /** eth_call both sides; assert byte-identical return OR byte-identical revert data. */
  async call(name, account, functionName, args = [], classify = null) {
    const res = await pairCall(this._req('a', account, functionName, args),
                               this._req('b', account, functionName, args))
    return this._compareCall(name, res, classify)
  }

  _compareCall(name, res, classify) {
    const da = res.a.data, db = res.b.data
    if (res.a.ok !== res.b.ok) {
      ok(`${name}: same outcome`, false, `v1.10 ok=${res.a.ok} (${res.a.message||''}) v1.11 ok=${res.b.ok} (${res.b.message||''})`)
      stop(`${name}: one side reverted and the other did not`)
      return res
    }
    if (da === db) { ok(`${name}: byte-identical ${res.a.ok ? 'return' : 'revert'} data`, true, describe(da)); return res }
    if (!res.a.ok && classify) {
      const good = classify(da, db)
      if (good) {
        note(good.cat, `${name}: revert data`, `v1.10=${String(da).slice(0,20)}… v1.11=${db}`)
        ok(`${name}: allowed revert-shape difference (${good.cat})`, true, good.detail)
        return res
      }
    }
    ok(`${name}: byte-identical data`, false, `v1.10=${da} v1.11=${db}`)
    stop(`${name}: data mismatch outside the allowed categories`)
    return res
  }

  /** Full state comparison. */
  async snap(name, probes = []) {
    const A = this.normA(await snapshotMarket(this.a.market, this.a.abi, this.actors, probes))
    const B = this.normB(await snapshotMarket(this.b.market, this.b.abi, this.actors, probes))
    const d = diff(A, B)
    ok(`${name}: full state identical`, d.length === 0,
       d.length === 0 ? `${Object.keys(A._reads).length} getters + ${A.betCount} bets + balances`
                      : '\n      ' + d.map(x => `${x.path}: v1.10=${x.a} v1.11=${x.b}`).join('\n      '))
    if (d.length) stop(`${name}: state diverged`)
    return { A, B, diff: d }
  }
}

/** Classifier for the pause-string vs MarketPaused() difference (category ii). */
export const classifyPause = (da, db) =>
  (String(da).startsWith(ERR_STRING_SEL) && db === SEL_MARKETPAUSED)
    ? { cat: 'ii', detail: `v1.10 Error("Pausable: paused") -> v1.11 MarketPaused() ${SEL_MARKETPAUSED}` } : null

/** Classifier for the owner-string vs NotOwner() difference (category iii). */
export const classifyOwner = (da, db) =>
  (String(da).startsWith(ERR_STRING_SEL) && db === SEL_NOTOWNER)
    ? { cat: 'iii', detail: `v1.10 Error("Ownable: caller is not the owner") -> v1.11 NotOwner() ${SEL_NOTOWNER}` } : null
