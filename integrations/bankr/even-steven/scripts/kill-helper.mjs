// Test helper: runs `bet --confirm` in a child process whose Bankr /wallet/sign handler kills the process
// (SIGKILL) mid-signing, to prove a dead run leaves an intent that can never be reused.
const { createCli } = await import(process.env.ES_MODULE || './even-steven.mjs')
const { BANKR_CONFIG, ES_STATE_DIR, WALLET, MARKET, INTENT_ID } = process.env
const GAME = 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys'
const publicClient = {
  getCode: async () => '0x',
  readContract: async ({ functionName, args }) => {
    if (functionName === 'getMarketState') return [GAME, -35000n, 30_000_000n, 10_000_000n, 40_000_000n, true, false]
    if (functionName === 'FEE_PERCENT') return 200n
    if (functionName === 'gameIdByMarket') return GAME
    if (functionName === 'getBetsByAddress') return []
    throw new Error('unmocked ' + functionName)
  },
}
const fetchImpl = async (url) => {
  const u = new URL(url)
  if (u.pathname === '/wallet/me') return { status: 200, text: async () => JSON.stringify({ success: true, wallets: [{ chain: 'evm', address: WALLET }] }) }
  if (u.pathname === '/wallet/sign') process.kill(process.pid, 'SIGKILL')
  throw new Error('unexpected ' + url)
}
const cli = createCli({ env: { BANKR_CONFIG, ES_STATE_DIR }, fetchImpl, publicClient, log: () => {} })
await cli.run(['bet', '--confirm', INTENT_ID])
