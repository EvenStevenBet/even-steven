// Submits BaseScan verification for all three v1.10/v1.5 contracts via
// Etherscan's unified multichain API (chainid=8453 = Base mainnet).
// Requires ETHERSCAN_API_KEY in scripts/.env. Read-only besides the
// verification submission itself — no on-chain transaction.
import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: join(__dirname, '..', '.env') })
const API_KEY = process.env.ETHERSCAN_API_KEY
if (!API_KEY) {
  console.error('ETHERSCAN_API_KEY not set in scripts/.env')
  process.exit(1)
}

const sourceCode = readFileSync(join(__dirname, 'standard-json-input.json'), 'utf8')
const API_URL = 'https://api.etherscan.io/v2/api?chainid=8453'
const COMPILER_VERSION = 'v0.8.20+commit.a1b79de6'

const contracts = [
  {
    label: 'MarketDeployer v1.0',
    address: '0xa88b73cff7187f84f5615e396c5bf34daeea1d70',
    contractName: 'MarketDeployer-v1_0.sol:MarketDeployer',
    constructorArguments: '',
  },
  {
    label: 'SportsbookFactory v1.5',
    address: '0xf69d4c986bb9fa8177e74b8cb9e2c49f4200adbd',
    contractName: 'SportsbookFactory-v1_5.sol:SportsbookFactory',
    constructorArguments:
      '000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000002abf1bd76655de80edb3086114315eec75af500c000000000000000000000000a88b73cff7187f84f5615e396c5bf34daeea1d70',
  },
  {
    label: 'SportsbookMarket v1.10',
    address: '0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9',
    contractName: 'SportsbookMarket-v1_10.sol:SportsbookMarket',
    constructorArguments:
      '000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000002abf1bd76655de80edb3086114315eec75af500c0000000000000000000000000000000000000000000000000000000000000064ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c00000000000000000000000000000000000000000000000000000000000000c84153534552545f5452555448320000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4240',
  },
]

async function submit(contract) {
  const body = new URLSearchParams({
    apikey: API_KEY,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: contract.address,
    sourceCode,
    codeformat: 'solidity-standard-json-input',
    contractname: contract.contractName,
    compilerversion: COMPILER_VERSION,
    constructorArguements: contract.constructorArguments, // API's misspelling, required as-is
  })

  const res = await fetch(API_URL, { method: 'POST', body })
  const json = await res.json()
  return json
}

async function checkStatus(guid) {
  const url = `${API_URL}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${API_KEY}`
  const res = await fetch(url)
  return res.json()
}

async function main() {
  const results = []
  for (const contract of contracts) {
    console.log(`\n=== ${contract.label} (${contract.address}) ===`)
    const submission = await submit(contract)
    console.log('submit response:', submission)
    if (submission.status !== '1') {
      results.push({ ...contract, ok: false, error: submission.result })
      continue
    }
    const guid = submission.result
    // Poll for the async verification result.
    let status
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      status = await checkStatus(guid)
      console.log(`  poll ${i + 1}:`, status.result)
      if (status.result !== 'Pending in queue') break
    }
    results.push({ ...contract, ok: status?.status === '1', guid, final: status?.result })
  }

  console.log('\n=== SUMMARY ===')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  ${r.address}  ${r.final ?? r.error ?? ''}`)
  }
  if (results.some((r) => !r.ok)) process.exit(1)
}

main()
