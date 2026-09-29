// End-to-end test of the kickoff closer on a Base mainnet fork. Needs no keys.
//
//   terminal 1:  cd scripts/fork-tests && FORK_BLOCK=<recent block> npx hardhat node --port 8547
//   terminal 2:  node scripts/kickoff-closer.fork-test.mjs
//
// Opens a real Factory v1.6 market (impersonating the owner) with kickoff 75s out, places a bet,
// runs kickoff-closer.mjs unmodified against it with CLOSE_LEAD_SECONDS=30, then asserts that
// betting closed 25–35s before kickoff and that a bet after the close reverts. A second market
// with no CSV row must be left alone, raise a GitHub ::error, and fail the run without re-arming.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, pad, toHex, parseAbi, parseEventLogs, maxUint256 } from 'viem'
import { base } from 'viem/chains'

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547'
const OWNER = '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916'
const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BETTOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // hardhat account #1
const HERE = path.dirname(fileURLToPath(import.meta.url))

const chain = { ...base, rpcUrls: { default: { http: [RPC] } } }
const pub = createPublicClient({ chain, transport: http(RPC) })
const factoryAbi = parseAbi([
  'function createMarket(string gameId, int256 oracleZ, uint256 protocolSeed) returns (address)',
  'event MarketCreated(address indexed market, string gameId, int256 oracleZ, int256 spreadMax, int256 spreadMin, uint256 feePercent, address indexed creator)',
])
const marketAbi = parseAbi(['function bettingOpen() view returns (bool)', 'function bettingClosedAt() view returns (uint256)', 'function placeBet(bool greaterThan, uint256 stake)', 'error BettingIsClosed()'])
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)'])

let fails = 0
const check = (ok, label, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', label, extra); if (!ok) fails++ }
const rpc = (method, params) => pub.request({ method, params })

if (!String(await rpc('web3_clientVersion', [])).includes('HardhatNetwork')) throw new Error(`${RPC} is not a Hardhat fork`)

// A Hardhat fork's block clock is offset from wall time (it starts at the fork block's
// timestamp); on Base itself block timestamps track wall time. Measure the offset so the
// close time can be compared with the wall-clock kickoff.
await rpc('evm_mine', [])
const offsetS = Number((await pub.getBlock()).timestamp) - Date.now() / 1000
console.log(`fork clock offset ${offsetS.toFixed(1)}s`)

// 1. Open a market as the owner, kickoff 75s from now.
await rpc('hardhat_impersonateAccount', [OWNER])
await rpc('hardhat_setBalance', [OWNER, toHex(10n ** 18n)])
const owner = createWalletClient({ account: OWNER, chain, transport: http(RPC) })
const kickoff = new Date(Math.ceil(Date.now() / 1000 + 75) * 1000)
const gameId = `NFL-${kickoff.toISOString().slice(0, 10)}-HOME-Testers-AWAY-Forkers-${Date.now() % 100000}`
const created = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: 'createMarket', args: [gameId, 0n, 1_000_000n] }) })
const market = parseEventLogs({ abi: factoryAbi, eventName: 'MarketCreated', logs: created.logs })[0].args.market
check(await pub.readContract({ address: market, abi: marketAbi, functionName: 'bettingOpen' }), 'market opened on the fork', market)
const orphanId = `${gameId}-NOROW`
const orphanRc = await pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: 'createMarket', args: [orphanId, 0n, 1_000_000n] }) })
const orphan = parseEventLogs({ abi: factoryAbi, eventName: 'MarketCreated', logs: orphanRc.logs })[0].args.market

// 2. A bet before kickoff goes through.
const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [BETTOR, 9n])) // FiatTokenV2_2 balances
await rpc('hardhat_setStorageAt', [USDC, slot, pad(toHex(100_000_000n))])
await rpc('hardhat_impersonateAccount', [BETTOR])
const bettor = createWalletClient({ account: BETTOR, chain, transport: http(RPC) })
await pub.waitForTransactionReceipt({ hash: await bettor.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [market, maxUint256] }) })
const early = await pub.waitForTransactionReceipt({ hash: await bettor.writeContract({ address: market, abi: marketAbi, functionName: 'placeBet', args: [true, 1_000_000n] }) })
check(early.status === 'success', 'bet before kickoff accepted')

// 3. Run the closer, unmodified, against a CSV that holds only this market's row.
const csv = path.join(os.tmpdir(), `kickoff-closer-${Date.now()}.csv`)
fs.writeFileSync(csv, 'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved\n' +
  `${gameId},NFL,Testers,Forkers,${kickoff.toISOString().replace('.000Z', 'Z')},open,${market},,2026-01-01T00:00:00Z,fork test,yes\n`)
console.log(`kickoff ${kickoff.toISOString()} — running kickoff-closer.mjs (lead 30s)…`)
const logs = []
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, 'kickoff-closer.mjs')], {
    env: { ...process.env, RPC_URL: RPC, FORK_IMPERSONATE: 'true', PRODUCTION_WALLET: OWNER, FACTORY_ADDRESS: FACTORY,
           MARKETS_CSV: csv, CLOSE_LEAD_SECONDS: '30', POLL_SECONDS: '5', GITHUB_TOKEN: '', GITHUB_OUTPUT: '' },
  })
  child.stdout.on('data', (d) => { for (const l of String(d).trim().split('\n')) { logs.push(l); console.log('  closer>', l) } })
  child.stderr.on('data', (d) => process.stderr.write(d))
  child.on('exit', resolve)
  setTimeout(() => child.kill(), 180_000)
})
check(code === 1, 'closer exited non-zero: only an untimed market was left')
check(logs.some((l) => l.startsWith('::error') && l.includes(orphanId)), 'GitHub ::error annotation names the untimed market')
check(await pub.readContract({ address: orphan, abi: marketAbi, functionName: 'bettingOpen' }), 'untimed market left open (never guessed)')

// 4. Closed on time, and bets are refused after.
const closedAt = Number(await pub.readContract({ address: market, abi: marketAbi, functionName: 'bettingClosedAt' }))
const lead = Math.round(kickoff.getTime() / 1000 - (closedAt - offsetS))
check(!(await pub.readContract({ address: market, abi: marketAbi, functionName: 'bettingOpen' })), 'bettingOpen is false')
check(lead >= 25 && lead <= 35, 'closed 25–35s before kickoff', `(${lead}s)`)
check(logs.some((l) => l.includes('"event":"closed"')) && logs.some((l) => l.includes('"rearm":"false"')), 'closer logged the close and did not re-arm')
let rejected = false
try {
  await pub.simulateContract({ address: market, abi: marketAbi, functionName: 'placeBet', args: [false, 1_000_000n], account: BETTOR })
} catch (err) {
  rejected = /BettingIsClosed/.test(err.shortMessage + err.message)
}
check(rejected, 'a bet after the close reverts BettingIsClosed')

fs.rmSync(csv, { force: true })
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
