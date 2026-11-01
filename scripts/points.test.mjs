// node --test scripts/points.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePoints, isOwnBuilderCode } from './points.mjs'

const M = '0x1111111111111111111111111111111111111111'
const alice = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const bob = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const carol = '0xcccccccccccccccccccccccccccccccccccccccc'
const rates = { pointsPerUsdc: 100n, refPointsPerUsdc: 50n }

test('three bets, one referred — matches the hand calculation', () => {
  const bets = [
    { marketAddress: M, betId: 0n, bettor: alice, stake: 10_000_000n }, // 10 USDC   → alice 1000
    { marketAddress: M, betId: 1n, bettor: bob, stake: 2_500_000n },    // 2.5 USDC  → bob 250, carol 125
    { marketAddress: M, betId: 2n, bettor: alice, stake: 1_000_000n },  // 1 USDC    → alice 100
  ]
  const records = [{ marketAddress: M, betId: '1', refAddress: carol, stake: '2500000' }]
  assert.deepEqual(computePoints(bets, records, rates), [
    { address: alice, total: 1100, betPoints: 1100, referralPoints: 0 },
    { address: bob, total: 250, betPoints: 250, referralPoints: 0 },
    { address: carol, total: 125, betPoints: 0, referralPoints: 125 },
  ])
})

test('self-referral, stake mismatch, unknown bet and duplicate records earn nothing extra', () => {
  const bets = [
    { marketAddress: M, betId: 0n, bettor: alice, stake: 1_000_000n },
    { marketAddress: M, betId: 1n, bettor: bob, stake: 1_000_000n },
  ]
  const records = [
    { marketAddress: M, betId: '0', refAddress: alice.toUpperCase().replace('0X', '0x'), stake: '1000000' }, // self
    { marketAddress: M, betId: '1', refAddress: carol, stake: '999999' },                                  // mismatch
    { marketAddress: M, betId: '9', refAddress: carol, stake: '1000000' },                                 // no such bet
    { marketAddress: M, betId: '1', refAddress: null, stake: '1000000' },                                  // unattributed
  ]
  assert.deepEqual(computePoints(bets, records, rates).map((r) => [r.address, r.total]), [[alice, 100], [bob, 100]])

  const dup = [
    { marketAddress: M.toUpperCase().replace('0X', '0x'), betId: '1', refAddress: carol, stake: '1000000' },
    { marketAddress: M, betId: '1', refAddress: carol, stake: '1000000' },
  ]
  assert.equal(computePoints(bets, dup, rates).find((r) => r.address === carol).referralPoints, 50)
})

test('fractional stakes floor per bet', () => {
  const bets = [{ marketAddress: M, betId: 0n, bettor: alice, stake: 1_234_567n }]
  assert.equal(computePoints(bets, [], rates)[0].betPoints, 123)
})

test('Even Steven\'s own builder codes, current and legacy, never earn referral points', () => {
  const bets = [{ marketAddress: M, betId: 0n, bettor: alice, stake: 1_000_000n }]
  for (const code of ['bc_2wk26wh0', 'BC_2WK26WH0', 'bc_ncytgilx', 'Bc_NcYtGiLx']) {
    const records = [{ marketAddress: M, betId: '0', ref: code, refAddress: carol, stake: '1000000' }]
    assert.deepEqual(computePoints(bets, records, rates).map((r) => r.address), [alice], code)
  }
})

test('neither Even Steven code earns a fee share either: a third-party ref still counts next to them', () => {
  const bets = [{ marketAddress: M, betId: 0n, bettor: alice, stake: 1_000_000n }]
  const records = [{ marketAddress: M, betId: '0', ref: 'alice-picks', refAddress: carol, stake: '1000000' }]
  assert.equal(computePoints(bets, records, rates).find((r) => r.address === carol).referralPoints, 50)
  assert.equal(isOwnBuilderCode('bc_2wk26wh0'), true)
  assert.equal(isOwnBuilderCode('bc_ncytgilx'), true)
  assert.equal(isOwnBuilderCode('alice-picks'), false)
})
