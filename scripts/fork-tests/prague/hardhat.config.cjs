const path = require('path'); const fs = require('fs'); const os = require('os')
const CAND = [process.env.EVEN_STEVEN_ENV, path.join(os.homedir(), '.even-steven', '.env')].filter(Boolean)
const F = CAND.find(p => { try { return fs.statSync(p).isFile() } catch { return false } })
if (F) require('dotenv').config({ path: F })
const RPC = process.env.ALCHEMY_RPC_URL
if (!RPC) throw new Error('ALCHEMY_RPC_URL not found')
module.exports = {
  solidity: '0.8.20',
  paths: { cache: '/tmp/hh-prague/cache', artifacts: '/tmp/hh-prague/artifacts' },
  networks: { hardhat: {
    chainId: 8453,
    hardfork: 'prague',                     // EIP-7702 is only live from Prague
    allowUnlimitedContractSize: false,
    blockGasLimit: 200000000,
    forking: { url: RPC, blockNumber: 51588000 },
    chains: { 8453: { hardforkHistory: { prague: 0 } } },
    accounts: { count: 10, accountsBalance: '100000000000000000000000' },
    loggingEnabled: false,
  } },
}
