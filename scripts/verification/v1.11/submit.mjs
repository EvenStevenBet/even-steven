// Submits BaseScan verification for the three v1.11/v1.6 contracts via Etherscan's
// unified multichain API (chainid=8453 = Base mainnet).
//
// Sends no on-chain transaction and costs no gas — it uploads source for an
// already-deployed address. The env file is resolved the same way as every other
// script here ($EVEN_STEVEN_ENV, ~/.even-steven/.env, scripts/.env).
//
// Constructor arguments below were ABI-encoded from values READ OFF the deployed
// contracts, not retyped from the plan.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnv } from '../../env-resolve.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv(join(__dirname, '..', '..'))
const API_KEY = process.env.ETHERSCAN_API_KEY
if (!API_KEY) { console.error('ETHERSCAN_API_KEY not set'); process.exit(1) }

const sourceCode = readFileSync(join(__dirname, 'standard-json-input.json'), 'utf8')
const API_URL = 'https://api.etherscan.io/v2/api?chainid=8453'
const COMPILER_VERSION = 'v0.8.20+commit.a1b79de6'

const USDC = '000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const OO   = '0000000000000000000000002abf1bd76655de80edb3086114315eec75af500c'
const DEP  = '000000000000000000000000b86d291104d23d47906776538db82191681257c2'

const contracts = [
  { label: 'MarketDeployer v1.1',
    address: '0xb86d291104d23d47906776538db82191681257c2',
    contractName: 'MarketDeployer-v1_1.sol:MarketDeployer',
    constructorArguments: '' },
  { label: 'SportsbookFactory v1.6',
    address: '0x5906370b9831728ec523b647137a1bbf0ab45390',
    contractName: 'SportsbookFactory-v1_6.sol:SportsbookFactory',
    constructorArguments: USDC + OO + DEP },
  { label: 'SportsbookMarket v1.11',
    address: '0x1b274610a413D3FB9A4b0DE04ae13dB3598B5B13',
    contractName: 'SportsbookMarket-v1_11.sol:SportsbookMarket',
    constructorArguments: USDC + OO +
      '0000000000000000000000000000000000000000000000000000000000000064' + // spreadMax  100
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c' + // spreadMin -100
      '00000000000000000000000000000000000000000000000000000000000000c8' + // feePercent 200
      '4153534552545f54525554483200000000000000000000000000000000000000' + // ASSERT_TRUTH2
      '00000000000000000000000000000000000000000000000000000000000f4240' }, // seed 1 USDC
]

const redact = s => String(s).split(API_KEY).join('<API-KEY-REDACTED>')

async function submit(c) {
  const body = new URLSearchParams({
    apikey: API_KEY, module: 'contract', action: 'verifysourcecode',
    contractaddress: c.address, sourceCode, codeformat: 'solidity-standard-json-input',
    contractname: c.contractName, compilerversion: COMPILER_VERSION,
    constructorArguements: c.constructorArguments, // the API's own misspelling, required as-is
  })
  const res = await fetch(API_URL, { method: 'POST', body })
  return res.json()
}
async function checkStatus(guid) {
  const body = new URLSearchParams({ apikey: API_KEY, module: 'contract',
    action: 'checkverifystatus', guid })
  const res = await fetch(API_URL, { method: 'POST', body })
  return res.json()
}
async function alreadyVerified(address) {
  const body = new URLSearchParams({ apikey: API_KEY, module: 'contract',
    action: 'getsourcecode', address })
  const res = await fetch(API_URL, { method: 'POST', body })
  const j = await res.json()
  const r = Array.isArray(j.result) ? j.result[0] : null
  return r && r.SourceCode && r.SourceCode.length > 0 ? r : null
}

const results = []
for (const c of contracts) {
  console.log(`\n=== ${c.label} (${c.address}) ===`)
  const pre = await alreadyVerified(c.address)
  if (pre) {
    console.log('  already verified as:', pre.ContractName, '| compiler', pre.CompilerVersion, '| runs', pre.Runs)
    results.push({ ...c, ok: true, final: 'Already Verified' })
    continue
  }
  const sub = await submit(c)
  console.log('  submit:', redact(JSON.stringify(sub)))
  if (sub.status !== '1') { results.push({ ...c, ok: false, error: sub.result }); continue }
  const guid = sub.result
  let status
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000))
    status = await checkStatus(guid)
    console.log(`  poll ${i + 1}:`, redact(status.result))
    if (status.result !== 'Pending in queue') break
  }
  const ok = status?.status === '1' || /already verified/i.test(status?.result || '')
  results.push({ ...c, ok, guid, final: status?.result })
}

console.log('\n=== SUMMARY ===')
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(24)} ${r.address}  ${redact(r.final ?? r.error ?? '')}`)
console.log('\nBaseScan:')
for (const r of results) console.log(`  ${r.label.padEnd(24)} https://basescan.org/address/${r.address}#code`)
if (results.some(r => !r.ok)) process.exit(1)
