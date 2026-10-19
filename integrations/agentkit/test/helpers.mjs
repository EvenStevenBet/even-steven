import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MAGIC_1271 } from '../dist/shared'
export const wallet = privateKeyToAccount(generatePrivateKey())
export const other = privateKeyToAccount(generatePrivateKey())
export const MK1 = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26'   // Dolphins/Chiefs
export const MK2 = '0x7aEb7eb0812e9150b13Ce45CE08b82d4406c8F5E'   // Packers/Cowboys
export const MK3 = '0x3333333333333333333333333333333333333333'   // Cowboys/Giants
export const FOREIGN = '0x4444444444444444444444444444444444444444'
export const SALT = '0x' + '5a'.repeat(32)
export const NOW = 1_800_000_000

export function world(over = {}) {
  return {
    fee: 200n,
    markets: {
      [MK1.toLowerCase()]: { gameId: 'NFL-2026-10-18-HOME-Dolphins-AWAY-Chiefs', z: 0n, g: 11_000_000n, le: 11_000_000n, open: true, settled: false },
      [MK2.toLowerCase()]: { gameId: 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys', z: -35000n, g: 30_000_000n, le: 10_000_000n, open: true, settled: false },
      [MK3.toLowerCase()]: { gameId: 'NFL-2026-10-25-HOME-Cowboys-AWAY-Giants', z: 20000n, g: 3_000_000n, le: 3_000_000n, open: true, settled: false },
    },
    open: [MK1, MK2, MK3], all: [MK1, MK2, MK3], bets: {}, code: '0x', ...over,
  }
}
export function chain(w) {
  const calls = []
  return { calls, getCode: async () => w.code,
    readContract: async ({ address, functionName, args }) => {
      calls.push(functionName)
      const mk = w.markets[String(address).toLowerCase()]
      switch (functionName) {
        case 'getOpenMarkets': return w.open
        case 'getAllMarkets': return w.all
        case 'gameIdByMarket': return w.markets[String(args[0]).toLowerCase()]?.gameId ?? ''
        case 'marketByGameId': return Object.entries(w.markets).find(([, v]) => v.gameId === args[0])?.[0] ?? '0x0000000000000000000000000000000000000000'
        case 'getMarketState': return [mk.gameId, mk.z, mk.g, mk.le, mk.g + mk.le, mk.open, mk.settled]
        case 'FEE_PERCENT': return w.fee
        case 'getMarketEV': return [args[0] * 3n / 2n, args[0] * 2n, w.fee]
        case 'getBetsByAddress': return (w.bets[String(address).toLowerCase()] || []).map((_, i) => BigInt(i))
        case 'getBet': return w.bets[String(address).toLowerCase()][Number(args[0])]
        case 'isValidSignature': return w.erc1271 ?? MAGIC_1271
        default: throw new Error('unmocked ' + functionName)
      }
    } }
}
export const signTd = (acct, td) => acct.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } })
export const okBet = (o = {}) => ({ success: true, betId: '3', bettor: wallet.address, relay: '0x8a3e', marketAddress: MK2, gameId: 'x', greaterThan: false, stake: '10000000', fee: '200000', lockedZ: '-35000', lockedZDisplay: '-3.5', txHash: '0x' + 'ab'.repeat(32), blockNumber: '1', ...o })
