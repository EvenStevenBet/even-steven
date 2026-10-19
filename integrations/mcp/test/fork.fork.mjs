// Fork test (Base mainnet fork, real Circle USDC, a v1.6 factory and v1.11 markets deployed from our solc artifacts; no keys).
// The MCP server runs through its real HTTP handler. The "client" is a throwaway key that signs the typed data from
// prepare_bet. A fork-side shim stands in for the relay and submits submit_bet's exact payload to placeBetFor or
// placeBetForWithSignature.
//   cd ../../scripts/fork-tests && npx hardhat node       # terminal 1
//   node test/fork.fork.mjs                                # terminal 2 (from integrations/mcp)
import { compileSet, compileTestContract, V111, assertSolc } from '../../../scripts/fork-tests/lib/compile.mjs'
import { pub, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi } from '../../../scripts/fork-tests/lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from '../../../scripts/fork-tests/lib/deploy.mjs'
import { ok, eq, section, summary } from '../../../scripts/fork-tests/lib/report.mjs'
import { encodeAbiParameters, getAddress, decodeEventLog, size } from 'viem'
import { handle } from '../src/server.mjs'

const USD = (n) => BigInt(Math.round(n * 1e6))
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const wrap = (idx, sig) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [idx, sig])
const signTd = (acc, td) => acc.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } })

console.log('solc      :', assertSolc()); console.log('fork block:', (await pub.getBlockNumber()).toString())
await assertFreshActors(5)
const [OWNER, RELAY, EOA, WOWNER, STRANGER] = [0, 1, 2, 3, 4].map(acct)
for (const a of [OWNER, RELAY]) await setBalanceEth(a.address, 10n ** 22n)
await mintUSDC(OWNER.address, USD(1000)); await mintUSDC(EOA.address, USD(100))
const arts = compileSet(V111, 200); const set = await deployVersionSet(arts, OWNER); const M = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)
const newMarket = async (h, a) => (await createMarket(set, OWNER, `NFL-2026-11-01-HOME-${h}-AWAY-${a}`, -35000n, USD(1))).market
const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
const SW = (await pub.waitForTransactionReceipt({ hash: await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, 0] }) })).contractAddress
await mintUSDC(SW, USD(100))

const relayCalls = []
const relayShim = async (url, init = {}) => {
  const p = JSON.parse(init.body); relayCalls.push(p)
  const fn = size(p.signature) === 65 ? 'placeBetFor' : 'placeBetForWithSignature'
  const common = { validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), nonce: p.nonce, salt: p.salt }
  const auth = fn === 'placeBetFor' ? { ...common, v: Number('0x' + p.signature.slice(130, 132)), r: '0x' + p.signature.slice(2, 66), s: '0x' + p.signature.slice(66, 130) } : { ...common, signature: p.signature }
  try {
    const h = await wallet(RELAY).writeContract({ address: p.marketAddress, abi: M, functionName: fn, args: [p.bettor, p.greaterThan, BigInt(p.stake), auth] })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    const bp = r.logs.filter((l) => l.address.toLowerCase() === p.marketAddress.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: M, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'BetPlaced')
    return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, betId: bp.args.betId.toString(), fee: bp.args.fee.toString(), lockedZ: bp.args.lockedZ.toString(), lockedZDisplay: String(Number(bp.args.lockedZ) / 10000), txHash: h, stake: p.stake }) }
  } catch (e) { return { status: 422, ok: false, text: async () => JSON.stringify({ error: 'AuthorizationRejected', reason: 'AuthorizationUsedOrCanceled' }) } }
}
const deps = () => ({ publicClient: pub, factory: set.factory, fetchImpl: relayShim, now: () => Number(blockTs), maxStake: 25 })
let blockTs = (await pub.getBlock()).timestamp
const call = async (name, args) => { blockTs = (await pub.getBlock()).timestamp
  const res = await handle(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), deps())
  return (await res.json()).result }
const betsOf = (m, w) => pub.readContract({ address: m, abi: M, functionName: 'getBetsByAddress', args: [w] })

section('M1  EOA: prepare_bet -> client signs -> submit_bet -> placeBetFor, all through the MCP HTTP handler')
{
  const market = await newMarket('Packers', 'Cowboys'); const before = await bal(EOA.address), relayBefore = await bal(RELAY.address)
  const p = (await call('prepare_bet', { game: 'Packers Cowboys', side: 'away', stake: '10', bettor: EOA.address })).structuredContent
  eq('M1 prepare ready', p.status, 'ready'); eq('M1 the server signed nothing and moved nothing', await bal(EOA.address), before)
  const sig = await signTd(EOA, p.typedData)
  const s = (await call('submit_bet', { ...p.relayPayload, signature: sig })).structuredContent
  eq('M1 placed', s.placed, true); ok('M1 locked line names the team', /^Cowboys -3\.5/.test(s.lockedLine), s.lockedLine)
  const ids = await betsOf(market, EOA.address); eq('M1 one bet for the signer', ids.length, 1)
  const b = await pub.readContract({ address: market, abi: M, functionName: 'getBet', args: [ids[0]] })
  eq('M1 Bet.bettor == signer', getAddress(b.bettor), getAddress(EOA.address)); eq('M1 away side', b.greaterThan, false); eq('M1 locked z', b.lockedZ, -35000n)
  eq('M1 wallet paid stake + 2% fee', before - await bal(EOA.address), USD(10.2)); eq('M1 relay never held USDC', await bal(RELAY.address) - relayBefore, 0n)
}
section('M2  ERC-1271 wallet, wrapped non-65-byte signature -> placeBetForWithSignature')
{
  const market = await newMarket('Bears', 'Lions'); const before = await bal(SW)
  const p = (await call('prepare_bet', { game: 'Bears Lions', side: 'home', stake: '10', bettor: SW })).structuredContent
  const sig = wrap(0n, await signTd(WOWNER, p.typedData)); ok('M2 signature is not 65 bytes', size(sig) !== 65, String(size(sig)))
  const s = (await call('submit_bet', { ...p.relayPayload, signature: sig })).structuredContent
  eq('M2 placed', s.placed, true); eq('M2 one bet for the wallet', (await betsOf(market, SW)).length, 1); eq('M2 wallet paid stake + fee', before - await bal(SW), USD(10.2))
}
section('M3  tampered or wrongly signed payloads never reach the relay')
{
  await newMarket('Jets', 'Giants'); const n0 = relayCalls.length
  const p = (await call('prepare_bet', { game: 'Jets Giants', side: 'home', stake: '10', bettor: EOA.address })).structuredContent
  const good = await signTd(EOA, p.typedData)
  const r1 = await call('submit_bet', { ...p.relayPayload, stake: '20000000', signature: good }); eq('M3 changed stake rejected', r1.isError, true)
  const r2 = await call('submit_bet', { ...p.relayPayload, greaterThan: false, signature: good }); eq('M3 flipped side rejected', r2.isError, true)
  const r3 = await call('submit_bet', { ...p.relayPayload, signature: await signTd(STRANGER, p.typedData) }); eq('M3 stranger signature rejected', r3.isError, true)
  const r4 = await call('submit_bet', { ...p.relayPayload, marketAddress: set.factory, signature: good }); eq('M3 non-market recipient rejected', r4.isError, true)
  eq('M3 the relay was never called', relayCalls.length, n0)
  const ok1 = (await call('submit_bet', { ...p.relayPayload, signature: good })).structuredContent; eq('M3 the untampered payload still works', ok1.placed, true)
}
section('M4  replaying a placed submission is refused (USDC nonce is single-use) and costs nothing')
{
  const market = await newMarket('Colts', 'Titans'); const before = await bal(EOA.address)
  const p = (await call('prepare_bet', { game: 'Colts Titans', side: 'away', stake: '10', bettor: EOA.address })).structuredContent
  const args = { ...p.relayPayload, signature: await signTd(EOA, p.typedData) }
  eq('M4 first submit placed', (await call('submit_bet', args)).structuredContent.placed, true)
  const again = (await call('submit_bet', args)).structuredContent
  eq('M4 second submit not placed', again.placed, false); eq('M4 told to check status, not re-sign', again.class, 'status')
  eq('M4 exactly one bet on chain', (await betsOf(market, EOA.address)).length, 1); eq('M4 wallet paid once', before - await bal(EOA.address), USD(10.2))
}
const s = summary(); process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
