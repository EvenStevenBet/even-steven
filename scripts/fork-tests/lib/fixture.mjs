import { compileSet, V110, V111, assertSolc } from './compile.mjs'
import { pub, acct, mintUSDC, USDC, erc20Abi, wallet, setBalanceEth, assertFreshActors } from './chain.mjs'
import { deployVersionSet, approveMax, createMarket } from './deploy.mjs'
import { Pair } from './pair.mjs'

export const USD = n => BigInt(Math.round(n * 1e6))

export const ROLES = {
  OWNER: 0,      // factory owner / market creator / fee recipient / asserter
  ALICE: 1,      // greater-side bettor
  BOB:   2,      // less-equal-side bettor
  CAROL: 3,
  RELAY: 4,      // submits relayed txs, never a bettor
  AGENT: 5,      // EIP-3009 signer; deliberately holds no ETH in N15
  DAVE:  6,
}

export async function buildWorld(runsA = 1, runsB = 1) {
  assertSolc()
  const artsA = compileSet(V110, runsA)
  const artsB = compileSet(V111, runsB)
  const nActors = Object.keys(ROLES).length
  await assertFreshActors(nActors)
  for (let i = 0; i < nActors; i++) await setBalanceEth(acct(i).address, 10n ** 23n)
  const owner = acct(ROLES.OWNER)
  const setA = await deployVersionSet(artsA, owner)
  const setB = await deployVersionSet(artsB, owner)
  const actors = {}
  for (const [name, i] of Object.entries(ROLES)) actors[name] = acct(i).address
  // fund every actor generously, then approve both factories and (later) markets
  for (const a of Object.values(actors)) await mintUSDC(a, USD(2000000))
  await approveMax(owner, setA.factory)
  await approveMax(owner, setB.factory)
  return { artsA, artsB, setA, setB, owner, actors, runsA, runsB }
}

let seq = 0
export async function newPair(world, { seed = USD(1), oracleZ = 0n, tag = '' } = {}) {
  const gameId = `NFL-2026-01-15-HOME-Chiefs-AWAY-49ers-${tag}-${seq++}`
  const a = await createMarket(world.setA, world.owner, gameId, oracleZ, seed)
  const b = await createMarket(world.setB, world.owner, gameId, oracleZ, seed)
  const pair = new Pair(
    { set: world.setA, market: a.market, abi: world.artsA.SportsbookMarket.abi },
    { set: world.setB, market: b.market, abi: world.artsB.SportsbookMarket.abi },
    world.actors)
  pair.createReceipts = { a, b }
  pair.gameId = gameId
  return pair
}

/** Approve both markets from one account (bettors must approve each market). */
export async function approveBoth(pair, account) {
  await approveMax(account, pair.a.market)
  await approveMax(account, pair.b.market)
}
