import { test } from 'node:test'
import assert from 'node:assert/strict'
import { belowThreshold, WALLETS } from './wallet-balance-check.mjs'

test('flags only wallets strictly below their threshold', () => {
  const rows = [
    { name: 'relay', balance: 2_099_999_999_999_999n, threshold: 2_100_000_000_000_000n },
    { name: 'owner', balance: 300_000_000_000_000n, threshold: 300_000_000_000_000n },
  ]
  assert.deepEqual(belowThreshold(rows).map((r) => r.name), ['relay'])
})

test('checks exactly the relay and the owner wallet, with env-overridable thresholds', () => {
  assert.deepEqual(WALLETS.map((w) => [w.name, w.env]), [['relay', 'RELAY_MIN_BALANCE_ETH'], ['owner', 'OWNER_MIN_BALANCE_ETH']])
})
