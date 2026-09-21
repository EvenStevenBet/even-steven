// Full-state snapshots and structural diffing for the differential suite.
import { pub, USDC, erc20Abi } from './chain.mjs'

export const j = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

/** Read every zero-argument view function in the ABI, plus the parameterised
 *  ones the suite cares about, plus the whole bets[] array. */
export async function snapshotMarket(market, abi, actors, probes = []) {
  const out = { _reads: {} }
  const views = abi.filter(e => e.type === 'function' && ['view', 'pure'].includes(e.stateMutability) && e.inputs.length === 0)
  for (const v of views) {
    try { out._reads[v.name] = await pub.readContract({ address: market, abi, functionName: v.name }) }
    catch (e) { out._reads[v.name] = 'REVERT:' + (e.shortMessage || e.message) }
  }
  const n = Number(out._reads.getBetCount ?? (await betCount(market, abi)))
  out.betCount = n
  out.bets = []
  for (let i = 0; i < n; i++)
    out.bets.push(await pub.readContract({ address: market, abi, functionName: 'getBet', args: [BigInt(i)] }))
  out.betsByAddress = {}
  out.usdc = {}
  for (const [label, a] of Object.entries(actors)) {
    out.betsByAddress[label] = await pub.readContract({ address: market, abi, functionName: 'getBetsByAddress', args: [a] })
    out.usdc[label] = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  }
  out.usdc.MARKET = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [market] })
  out.quotes = {}
  for (const stake of probes) {
    for (const side of [true, false]) {
      out.quotes[`EV_${stake}_${side}`]  = await pub.readContract({ address: market, abi, functionName: 'getMarketEV', args: [stake, side] })
      out.quotes[`SIM_${stake}_${side}`] = await pub.readContract({ address: market, abi, functionName: 'simulatePayout', args: [stake, side] })
    }
  }
  return out
}

async function betCount(market, abi) {
  // bets is a public array; there is no length getter, so walk getBet() until it reverts.
  let i = 0n
  for (;;) {
    try { await pub.readContract({ address: market, abi, functionName: 'getBet', args: [i] }); i++ }
    catch { return i }
  }
}

/** Replace version-specific addresses with stable tokens so two deployments compare equal. */
export function makeNormalizer(addrMap) {
  const pairs = Object.entries(addrMap).map(([tok, a]) => [a.toLowerCase().replace(/^0x/, ''), tok])
  return function norm(value) {
    let s = j(value)
    for (const [hex, tok] of pairs) s = s.replaceAll(hex, tok).replaceAll(hex.toUpperCase(), tok)
    return JSON.parse(s)
  }
}

/** Deep structural diff; returns [{path, a, b}]. */
export function diff(a, b, path = '', acc = []) {
  const ja = j(a), jb = j(b)
  if (ja === jb) return acc
  const isObj = v => v && typeof v === 'object'
  if (!isObj(a) || !isObj(b)) { acc.push({ path: path || '.', a: ja, b: jb }); return acc }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  for (const k of keys) diff(a?.[k], b?.[k], path ? `${path}.${k}` : k, acc)
  return acc
}

/** Normalised log view: address label + topics + data, market addresses tokenised. */
export function logView(receipt, norm, labels) {
  if (!receipt) return null
  return receipt.logs.map(l => norm({
    address: labels[l.address.toLowerCase()] || l.address.toLowerCase(),
    topics: l.topics,
    data: l.data,
  }))
}
