// Fork test for the AgentKit provider (compiled dist). Base mainnet fork, real USDC, v1.6 factory and v1.11 markets deployed from
// our artifacts, no keys. The wallet provider is a stand-in whose signTypedData uses a throwaway key; a relay shim submits the
// provider's exact payload to placeBetFor / placeBetForWithSignature.
//   cd ../../scripts/fork-tests && npx hardhat node ; then: npm run test:fork (from integrations/agentkit)
import { compileSet, compileTestContract, V111, assertSolc } from '../../../scripts/fork-tests/lib/compile.mjs'
import { pub, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi } from '../../../scripts/fork-tests/lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from '../../../scripts/fork-tests/lib/deploy.mjs'
import { ok, eq, section, summary } from '../../../scripts/fork-tests/lib/report.mjs'
import { encodeAbiParameters, getAddress, decodeEventLog, size } from 'viem'
import { createRequire } from 'node:module'
const { evenStevenActionProvider } = createRequire(import.meta.url)('../dist')

const realFetch = globalThis.fetch   // only AgentKit's own analytics ping is stubbed; the fork RPC still needs the real fetch
globalThis.fetch = (url, init) => String(url).includes('cca-lite.coinbase.com') ? Promise.resolve({ ok: true, status: 200, text: async () => '' }) : realFetch(url, init)
const USD = (n) => BigInt(Math.round(n * 1e6))
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const wrap = (idx, sig) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [idx, sig])

console.log('solc      :', assertSolc()); console.log('fork block:', (await pub.getBlockNumber()).toString())
await assertFreshActors(4)
const [OWNER, RELAY, EOA, WOWNER] = [0, 1, 2, 3].map(acct)
for (const a of [OWNER, RELAY]) await setBalanceEth(a.address, 10n ** 22n)
await mintUSDC(OWNER.address, USD(1000)); await mintUSDC(EOA.address, USD(100))
const arts = compileSet(V111, 200); const set = await deployVersionSet(arts, OWNER); const M = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)
const newMarket = async (h, a) => (await createMarket(set, OWNER, `NFL-2026-11-01-HOME-${h}-AWAY-${a}`, -35000n, USD(1))).market
const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
const SW = (await pub.waitForTransactionReceipt({ hash: await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, 0] }) })).contractAddress
await mintUSDC(SW, USD(100))

const relayShim = async (url, init = {}) => {
  const p = JSON.parse(init.body)
  const fn = size(p.signature) === 65 ? 'placeBetFor' : 'placeBetForWithSignature'
  const common = { validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), nonce: p.nonce, salt: p.salt }
  const auth = fn === 'placeBetFor' ? { ...common, v: Number('0x' + p.signature.slice(130, 132)), r: '0x' + p.signature.slice(2, 66), s: '0x' + p.signature.slice(66, 130) } : { ...common, signature: p.signature }
  try {
    const h = await wallet(RELAY).writeContract({ address: p.marketAddress, abi: M, functionName: fn, args: [p.bettor, p.greaterThan, BigInt(p.stake), auth] })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    const bp = r.logs.filter((l) => l.address.toLowerCase() === p.marketAddress.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: M, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'BetPlaced')
    return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, betId: bp.args.betId.toString(), fee: bp.args.fee.toString(), lockedZ: bp.args.lockedZ.toString(), lockedZDisplay: String(Number(bp.args.lockedZ) / 10000), txHash: h, stake: p.stake }) }
  } catch { return { status: 422, ok: false, text: async () => JSON.stringify({ error: 'AuthorizationRejected', reason: 'AuthorizationUsedOrCanceled' }) } }
}
function walletProvider(address, signFn) {
  const calls = { sign: 0 }
  return { calls, getName: () => 'fork-wallet', getAddress: () => address, getNetwork: () => ({ protocolFamily: 'evm', networkId: 'base-mainnet', chainId: '8453' }), getPublicClient: () => pub,
    signTypedData: async (td) => { calls.sign++; return signFn(td) },
    sendTransaction: () => { throw new Error('never') }, signTransaction: () => { throw new Error('never') } }
}
let blockTs = (await pub.getBlock()).timestamp
const provider = () => evenStevenActionProvider({ factory: set.factory, fetch: relayShim, now: () => Number(blockTs), maxStakeUsdc: 25 })
async function bet(w, game, side, double = false) {
  blockTs = (await pub.getBlock()).timestamp
  const acts = provider().getActions(w); const run = (n, a) => acts.find((x) => x.name.endsWith('_' + n)).invoke(a)
  const prep = await run('prepare_even_steven_bet', { game, side, stake: '10' })
  const m = /Intent id: ([0-9a-f]{8})/.exec(prep); if (!m) throw new Error('prepare said: ' + prep.slice(0, 300)); const id = m[1]
  const out = double ? await Promise.all([run('confirm_even_steven_bet', { intentId: id }), run('confirm_even_steven_bet', { intentId: id })]) : await run('confirm_even_steven_bet', { intentId: id })
  return { prep, out }
}
const betsOf = (m, who) => pub.readContract({ address: m, abi: M, functionName: 'getBetsByAddress', args: [who] })
const signWith = (acc) => (td) => acc.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message })

section('A1  EOA through the provider (wallet signTypedData, bigint uint256) -> placeBetFor')
{
  const market = await newMarket('Packers', 'Cowboys'); const before = await bal(EOA.address)
  const w = walletProvider(EOA.address, signWith(EOA)); const r = await bet(w, 'Packers Cowboys', 'away')
  ok('A1 placed', /Bet placed\. Cowboys -3\.5/.test(r.out), r.out.slice(0, 60)); eq('A1 signed exactly once', w.calls.sign, 1)
  const ids = await betsOf(market, EOA.address); eq('A1 one bet', ids.length, 1)
  const b = await pub.readContract({ address: market, abi: M, functionName: 'getBet', args: [ids[0]] })
  eq('A1 Bet.bettor == wallet', getAddress(b.bettor), getAddress(EOA.address)); eq('A1 paid stake + fee', before - await bal(EOA.address), USD(10.2))
}
section('A2  ERC-1271 wallet with a wrapped signature -> placeBetForWithSignature')
{
  const market = await newMarket('Bears', 'Lions'); const before = await bal(SW)
  const w = walletProvider(SW, async (td) => wrap(0n, await signWith(WOWNER)(td))); const r = await bet(w, 'Bears Lions', 'home')
  ok('A2 placed', /Bet placed/.test(r.out), r.out.slice(0, 80)); eq('A2 one bet for the wallet', (await betsOf(market, SW)).length, 1); eq('A2 paid stake + fee', before - await bal(SW), USD(10.2))
}
section('A3  a double confirm ends with exactly one signature and one bet')
{
  const market = await newMarket('Colts', 'Titans'); const before = await bal(EOA.address)
  const w = walletProvider(EOA.address, signWith(EOA)); const r = await bet(w, 'Colts Titans', 'away', true)
  eq('A3 one placed, one refused', r.out.filter((x) => /Bet placed/.test(x)).length + 10 * r.out.filter((x) => /already being confirmed/.test(x)).length, 11)
  eq('A3 signed once', w.calls.sign, 1); eq('A3 one bet on chain', (await betsOf(market, EOA.address)).length, 1); eq('A3 paid once', before - await bal(EOA.address), USD(10.2))
}
section('A4  the wrong key never reaches the relay')
{
  const market = await newMarket('Jets', 'Giants'); const before = await bal(EOA.address)
  const w = walletProvider(EOA.address, signWith(WOWNER)); const r = await bet(w, 'Jets Giants', 'home')
  ok('A4 refused', /does not verify/.test(r.out), r.out.slice(0, 80)); eq('A4 no bet', (await betsOf(market, EOA.address)).length, 0); eq('A4 no USDC moved', before - await bal(EOA.address), 0n)
}
const s = summary(); process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
