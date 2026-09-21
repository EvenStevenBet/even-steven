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

module.exports = {
  solidity: '0.8.20',
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
