// Higher-level flows shared by the differential and new-behaviour suites.
import { acct, increaseTime, pub, wallet } from './chain.mjs'
import { approveMax } from './deploy.mjs'
import { approveBoth, ROLES, USD } from './fixture.mjs'

export const LIVENESS = 7200

/** closeBetting -> requestSettlement -> wait real liveness -> executeSettlement, on BOTH sides. */
export async function settlePair(pair, ownerAccount, spread) {
  await approveBoth(pair, ownerAccount)            // bond is pulled from the asserter
  await pair.send('closeBetting', ownerAccount, 'closeBetting', [])
  await pair.send(`requestSettlement(${spread})`, ownerAccount, 'requestSettlement', [spread], { syncTokens: true })
  await increaseTime(LIVENESS + 100)
  await pair.send('executeSettlement', ownerAccount, 'executeSettlement', [])
}

/** Same flow against a single market (used by the v1.11-only suite). */
export async function settleOne(market, abi, ownerAccount, spread) {
  const w = wallet(ownerAccount)
  await approveMax(ownerAccount, market)
  for (const [fn, args] of [['closeBetting', []], ['requestSettlement', [spread]]]) {
    const h = await w.writeContract({ address: market, abi, functionName: fn, args })
    await pub.waitForTransactionReceipt({ hash: h })
  }
  await increaseTime(LIVENESS + 100)
  const h = await w.writeContract({ address: market, abi, functionName: 'executeSettlement', args: [] })
  return pub.waitForTransactionReceipt({ hash: h })
}
