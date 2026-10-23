#!/usr/bin/env node
// Read-only live check: for every settled market on Factory v1.6, compare what the skill TELLS a bettor
// (the win-condition sentence for each recorded bet) with what the chain says happened (whether that bet is a
// winner). Ground truth is the contract's own answer: a claimed bet won, and for an unclaimed bet an eth_call of
// claimPayoutFor succeeds only for a winner (NoPayout for a loser). No writes, no signing.
//
//   node scripts/verify-convention.mjs        (optional BASE_RPC_URL)
import { createPublicClient, http, getAddress, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { pathToFileURL } from 'node:url'
import { FACTORY, parseGameId, lineSentence } from './even-steven.mjs'
import { sentenceWins, contractWins } from './convention.mjs'

const ABI = parseAbi([
  'function getMarketState() view returns (string gameId, int256 z, uint256 gPool, uint256 lePool, uint256 tPool, bool isOpen, bool isSettled)',
  'function getMarketStatus() view returns (bool isCanceled, bool isPaused, bool assertionActive, uint256 claimDeadline, uint256 betsRemaining)',
  'function finalSpread() view returns (int256)',
  'function refundMode() view returns (bool)',
  'function bets(uint256) view returns (address bettor, uint256 stake, bool greaterThan, int256 lockedZ, bool claimed)',
  'function claimPayoutFor(address bettor, uint256[] betIds)',
  'error NoPayout()', 'error AlreadyClaimed()', 'error NotSettledYet()', 'error ClaimWindowExpired()', 'error NotYourBet()', 'error InvalidBetId()',
])
const FACTORY_ABI = parseAbi(['function getAllMarkets() view returns (address[])'])

export async function checkMarket(pc, address) {
  const [gameId, , , , , , settled] = await pc.readContract({ address, abi: ABI, functionName: 'getMarketState' })
  if (!settled) return { address, gameId, skipped: 'not settled' }
  if (await pc.readContract({ address, abi: ABI, functionName: 'refundMode' })) return { address, gameId, skipped: 'refund mode (no winners)' }
  const finalSpread = await pc.readContract({ address, abi: ABI, functionName: 'finalSpread' })
  const [, , , , remaining] = await pc.readContract({ address, abi: ABI, functionName: 'getMarketStatus' })
  const n = 1000 - Number(remaining)
  const { home, away } = parseGameId(gameId)
  const rows = []
  for (let i = 0; i < n; i++) {
    const [bettor, stake, greaterThan, lockedZ, claimed] = await pc.readContract({ address, abi: ABI, functionName: 'bets', args: [BigInt(i)] })
    const side = greaterThan ? 'home' : 'away'
    const sentence = lineSentence(lockedZ, side, home, away)
    let chainWon, how
    if (claimed) { chainWon = true; how = 'claimed' } else {
      try { await pc.simulateContract({ address, abi: ABI, functionName: 'claimPayoutFor', args: [bettor, [BigInt(i)]], account: bettor }); chainWon = true; how = 'claimable' }
      catch (e) {
        const name = e.cause?.data?.errorName ?? e.cause?.cause?.data?.errorName ?? (/NoPayout/.test(String(e.message)) ? 'NoPayout' : null)
        if (name === 'NoPayout') { chainWon = false; how = 'NoPayout' } else { chainWon = null; how = 'unknown revert: ' + (name || (e.shortMessage || '').slice(0, 50)) }
      }
    }
    rows.push({ id: i, side, stake, lockedZ, sentence, skillWon: sentenceWins(sentence, side, finalSpread), contractRuleWon: contractWins(lockedZ, side, finalSpread), chainWon, how })
  }
  return { address, gameId, finalSpread, rows }
}

export async function main(pc = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org') }), log = console.log) {
  const markets = await pc.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getAllMarkets' })
  let total = 0, agree = 0, ruleAgree = 0
  for (const a of markets) {
    const r = await checkMarket(pc, getAddress(a))
    if (r.skipped) { log(`${r.gameId}: skipped (${r.skipped})`); continue }
    log(`${r.gameId}  final spread (home - away) = ${r.finalSpread}`)
    for (const x of r.rows) {
      if (x.chainWon === null) { log(`  bet ${x.id}: ground truth unavailable (${x.how}), not counted`); continue }
      total++; if (x.skillWon === x.chainWon) agree++; if (x.contractRuleWon === x.chainWon) ruleAgree++
      log(`  bet ${String(x.id).padStart(2)} ${x.side.padEnd(4)} lockedZ ${String(x.lockedZ).padStart(7)}  "${x.sentence}"  skill: ${x.skillWon ? 'WIN ' : 'LOSE'}  chain: ${x.chainWon ? 'WIN ' : 'LOSE'} (${x.how})  ${x.skillWon === x.chainWon ? 'agree' : 'DISAGREE'}`)
    }
  }
  log(`\nSettled bets checked: ${total}. Skill sentence agrees with the chain: ${agree}/${total}. Contract rule agrees with the chain: ${ruleAgree}/${total}.`)
  return { total, agree, ruleAgree }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await main()
  process.exitCode = r.agree === r.total && r.total > 0 ? 0 : 1
}
