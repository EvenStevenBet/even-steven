// Entry point. Usage: node run.mjs [differential|new|all] (ONLY=D1,D2 to filter)
import { assertSolc, compileSet, V110, V111 } from './lib/compile.mjs'
import { buildWorld } from './lib/fixture.mjs'
import { pub } from './lib/chain.mjs'
import { summary, section } from './lib/report.mjs'
import { observed, ALLOWED } from './lib/pair.mjs'

const mode = process.argv[2] || 'all'
const RUNS_A = Number(process.env.RUNS_A || 1)
const RUNS_B = Number(process.env.RUNS_B || 1)

console.log('='.repeat(78))
console.log('EVEN STEVEN v3 FORK TESTS — SportsbookMarket v1.10 (live) vs v1.11 (candidate)')
console.log('='.repeat(78))
console.log('solc                :', assertSolc())
console.log('optimizer           : enabled, runs=%d (v1.10) / runs=%d (v1.11), evmVersion=shanghai', RUNS_A, RUNS_B)
console.log('fork                : Base mainnet (chainId 8453), PINNED BLOCK', (await pub.getBlockNumber()).toString())
console.log('EIP-170             : enforced (allowUnlimitedContractSize=false)')
console.log('USDC                : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (real Circle token)')
console.log('UMA OOv3            : 0x2aBf1Bd76655de80eDB3086114315Eec75AF500c (real oracle)')
const a = compileSet(V110, RUNS_A), b = compileSet(V111, RUNS_B)
for (const [n, arts] of [['v1.10 set', a], ['v1.11 set', b]]) {
  console.log(`${n} runtime sizes :`, ['SportsbookMarket', 'MarketDeployer', 'SportsbookFactory']
    .map(c => `${c}=${arts[c].runtimeSize}`).join('  '), `| compiler warnings: ${arts.warnings.length}`)
}

const world = await buildWorld(RUNS_A, RUNS_B)
console.log('deployed v1.10 set  : deployer/factory on-chain runtime', JSON.stringify(world.setA.sizes))
console.log('deployed v1.11 set  : deployer/factory on-chain runtime', JSON.stringify(world.setB.sizes))

let zTable = []
if (mode === 'differential' || mode === 'all') {
  const { runDifferential } = await import('./differential.mjs')
  const r = await runDifferential(world)
  zTable = r.zTable
}
if (mode === 'new' || mode === 'all') {
  const { runNew } = await import('./newbehaviour.mjs')
  await runNew(world)
}

if (zTable.length) {
  section('R6-6 Z LADDER (raw values, one-sided LESS stake)')
  console.log('  stake USDC | seeded Z   | seedless Z | identical')
  const byStake = {}
  for (const r of zTable) (byStake[r.stake] ??= {})[r.mode] = r
  for (const s of Object.keys(byStake).sort((x, y) => x - y)) {
    const e = byStake[s]
    console.log(`  ${String(s).padStart(10)} | ${String(e.seeded?.z).padStart(10)} | ${String(e.seedless?.z).padStart(10)} | ${e.seeded?.z === e.seedless?.z}`)
  }
}

section('OBSERVED DIFFERENCES BETWEEN v1.10 AND v1.11 (by allowed category)')
console.log('  (i)   extra BetClaimed / SettlementDetails logs :', ALLOWED.i)
console.log('  (ii)  MarketPaused() vs Error("Pausable: paused"):', ALLOWED.ii)
console.log('  (iii) NotOwner() vs Error("Ownable: ...")        :', ALLOWED.iii)
console.log('  (iv)  gas differences                           :', ALLOWED.iv)
console.log('  --- every observed difference ---')
for (const o of observed) console.log(`  (${o.cat})  ${o.what}  ${o.detail}`)

const s = summary()
process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
