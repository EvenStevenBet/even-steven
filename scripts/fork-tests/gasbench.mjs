// Stage 3b: gas for v1.11 compiled at a given optimizer `runs`, on the pinned fork.
// Usage: RUNS=200 node gasbench.mjs
import { compileSet, compileTestContract, V111, assertSolc } from './lib/compile.mjs'
import { pub, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi,
         increaseTime, signAuthorization } from './lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from './lib/deploy.mjs'
import { keccak256, toHex } from 'viem'

const RUNS = Number(process.env.RUNS || 1)
const USD = n => BigInt(Math.round(n * 1e6))
const SETTLE_SPREAD = 20n
const BIG_BETS = Number(process.env.BIG_BETS || 1000)

await assertFreshActors(5)
const [OWNER, ALICE, BOB, RELAY, AGENT] = [0, 1, 2, 3, 4].map(acct)
for (const a of [OWNER, ALICE, BOB, RELAY, AGENT]) {
  await setBalanceEth(a.address, 10n ** 23n)
  await mintUSDC(a.address, USD(2000000))
}

assertSolc()
const arts = compileSet(V111, RUNS)
const set = await deployVersionSet(arts, OWNER)
const ABI = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)

const rows = []
const record = (name, gas) => { rows.push({ name, gas }); console.log('  ' + name.padEnd(34), String(gas).padStart(12)) }

let seq = 0
async function mkMarket(seed = USD(1)) {
  const gid = `NFL-2026-03-01-HOME-Chiefs-AWAY-49ers-GB-${RUNS}-${seq++}`
  const r = await createMarket(set, OWNER, gid, 0n, seed)
  return { market: r.market, gas: r.receipt.gasUsed }
}
async function tx(account, market, fn, args) {
  const h = await wallet(account).writeContract({ address: market, abi: ABI, functionName: fn, args })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  if (r.status !== 'success') throw new Error(fn + ' reverted')
  return r
}
async function bet(market, account, side, stake) {
  await approveMax(account, market)
  return tx(account, market, 'placeBet', [side, stake])
}
async function settle(market) {
  await approveMax(OWNER, market)
  await tx(OWNER, market, 'closeBetting', [])
  const rq = await tx(OWNER, market, 'requestSettlement', [SETTLE_SPREAD])
  await increaseTime(7300)
  const ex = await tx(OWNER, market, 'executeSettlement', [])
  return { request: rq.gasUsed, execute: ex.gasUsed }
}

console.log('='.repeat(78))
console.log(`GAS BENCH — SportsbookMarket v1.11 @ optimizer runs=${RUNS}, shanghai, solc ${assertSolc()}`)
console.log(`fork block ${await pub.getBlockNumber()} | runtime sizes: Market=${arts.SportsbookMarket.runtimeSize} Deployer=${arts.MarketDeployer.runtimeSize} Factory=${arts.SportsbookFactory.runtimeSize}`)
console.log('='.repeat(78))
console.log('  case'.padEnd(36), 'gas'.padStart(12))

// createMarket through the factory
{ const m = await mkMarket(); record('createMarket (factory, seed 1e6)', m.gas) }

// placeBet (first bet into an empty seeded market) and placeBetFor
{
  const { market } = await mkMarket()
  record('placeBet (first, GREATER 100)', (await bet(market, ALICE, true, USD(100))).gasUsed)
  record('placeBet (second, LESS 100)',   (await bet(market, BOB, false, USD(100))).gasUsed)
}
{
  const { market } = await mkMarket()
  const stake = USD(100), fee = stake * 200n / 10000n
  const auth = await signAuthorization({ signer: AGENT, market, value: stake + fee,
                                         salt: keccak256(toHex('gb-' + RUNS)), greaterThan: true })
  const pack = { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce,
                 salt: auth.salt, v: auth.v, r: auth.r, s: auth.s }
  record('placeBetFor (EIP-3009, relayed)', (await tx(RELAY, market, 'placeBetFor', [AGENT.address, true, stake, pack])).gasUsed)
}

// settlement on a small market + the single-bet claim paths
{
  const { market } = await mkMarket()
  await bet(market, ALICE, true, USD(100))
  await bet(market, BOB, false, USD(100))
  const s = await settle(market)
  record('requestSettlement', s.request)
  record('executeSettlement (2 bets)', s.execute)
  record('claimPayout (1 bet)', (await tx(ALICE, market, 'claimPayout', [0n])).gasUsed)
}
// claimPayouts(2) and claimPayoutFor(1,2,10) on markets built identically
for (const n of [1, 2, 10]) {
  const build = async () => {
    const { market } = await mkMarket()
    for (let i = 0; i < n; i++) await bet(market, ALICE, true, USD(10))
    await bet(market, BOB, false, USD(10 * n))
    await settle(market)
    return market
  }
  const ids = Array.from({ length: n }, (_, i) => BigInt(i))
  const mF = await build(), mP = await build()
  record(`claimPayoutFor(${n} ids)`, (await tx(RELAY, mF, 'claimPayoutFor', [ALICE.address, ids])).gasUsed)
  record(`claimPayouts(${n} ids)`,   (await tx(ALICE, mP, 'claimPayouts', [ids])).gasUsed)
}

// executeSettlement at MAX_BETS
{
  const { market } = await mkMarket()
  const filler = compileTestContract('BetFiller.sol', 'BetFiller')
  const w = wallet(OWNER)
  const fh = await w.deployContract({ abi: filler.abi, bytecode: filler.bytecode, args: [] })
  const fAddr = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress
  await mintUSDC(fAddr, USD(1000000))
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: fAddr, abi: filler.abi,
    functionName: 'approveMarket', args: [USDC, market], gas: 200000n }) })
  const CHUNK = 200
  for (let done = 0; done < BIG_BETS; done += CHUNK) {
    const h = await w.writeContract({ address: fAddr, abi: filler.abi, functionName: 'fill',
      args: [market, BigInt(Math.min(CHUNK, BIG_BETS - done)), USD(1), BigInt(done)], gas: 190000000n })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') throw new Error('fill reverted at ' + done)
  }
  const s = await settle(market)
  record(`executeSettlement (${BIG_BETS} bets)`, s.execute)
}

console.log()
console.log('MACHINE-READABLE: ' + JSON.stringify({ runs: RUNS,
  sizes: { market: arts.SportsbookMarket.runtimeSize, deployer: arts.MarketDeployer.runtimeSize, factory: arts.SportsbookFactory.runtimeSize },
  gas: Object.fromEntries(rows.map(r => [r.name, Number(r.gas)])) }))
