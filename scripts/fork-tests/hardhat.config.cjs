// Fork-test network config. The RPC URL is read from ../.env (gitignored) and is
// never logged. Only eth_call / eth_getStorageAt style READS ever reach it —
// hardhat executes all transactions locally. No mainnet transaction is possible.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const RPC = process.env.ALCHEMY_RPC_URL
if (!RPC) throw new Error('ALCHEMY_RPC_URL missing from scripts/.env')

// PINNED Base mainnet fork block. Every measurement in the suite is taken
// against this block. Bump deliberately, never incidentally.
const FORK_BLOCK = Number(process.env.FORK_BLOCK || 51588000)

// Keep hardhat's fork cache OUT of the project tree. This repo lives under
// ~/Desktop, which is an iCloud-synced folder: a 60 MB+ cache of small files
// there puts fileproviderd/bird/cloudd into a permanent sync storm that starves
// the node and makes the suite an order of magnitude slower.
const CACHE_ROOT = process.env.HH_CACHE_DIR || path.join(require('os').tmpdir(), 'even-steven-fork-cache')

module.exports = {
  solidity: '0.8.20',
  paths: { cache: path.join(CACHE_ROOT, 'cache'), artifacts: path.join(CACHE_ROOT, 'artifacts') },
  networks: {
    hardhat: {
      chainId: 8453,
      hardfork: 'shanghai',
      // EIP-170 ENFORCED. The whole point of measuring runtime sizes is lost if
      // the test chain would happily deploy an oversized contract.
      allowUnlimitedContractSize: false,
      blockGasLimit: 200000000,
      forking: { url: RPC, blockNumber: FORK_BLOCK },
      // Base is not in hardhat's hardfork table; without this every eth_call
      // fails with "No known hardfork for execution on historical block".
      chains: { 8453: { hardforkHistory: { shanghai: 0 } } },
      accounts: { count: 30, accountsBalance: '100000000000000000000000' },
      loggingEnabled: false,
    },
  },
}
