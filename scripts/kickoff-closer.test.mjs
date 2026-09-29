// node --test scripts/kickoff-closer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseGameDate, plan, shouldHandOff } from './kickoff-closer.mjs'

const T = Date.parse('2026-09-29T00:15:00Z') // MNF kickoff

test('parseGameDate is strict: explicit timezone or nothing', () => {
  assert.equal(parseGameDate('2026-09-29T00:15:00Z'), T)
  assert.equal(parseGameDate('2026-09-28T17:15:00-07:00'), T)
  assert.equal(parseGameDate('2026-09-29 00:15:00'), null) // would be read as local time
  assert.equal(parseGameDate('09/29/2026'), null)
  assert.equal(parseGameDate(undefined), null)
})

test('plan: closes CLOSE_LEAD_SECONDS before kickoff, never guesses an untimed market', () => {
  const markets = [
    { address: '0xA', gameId: 'mnf', gameDateMs: T },
    { address: '0xB', gameId: 'later', gameDateMs: T + 3600_000 },
    { address: '0xC', gameId: 'no-row', gameDateMs: null },
  ]
  const before = plan(markets, T - 61_000, 60)
  assert.deepEqual(before.due, [])
  assert.equal(before.next.gameId, 'mnf')
  assert.equal(before.next.closeAtMs, T - 60_000)
  assert.deepEqual(before.unknown.map((m) => m.gameId), ['no-row'])

  const at = plan(markets, T - 60_000, 60)
  assert.deepEqual(at.due.map((m) => m.gameId), ['mnf'])
  assert.equal(at.next.gameId, 'later')

  // A watcher that starts late (after kickoff) still closes immediately.
  assert.deepEqual(plan(markets, T + 600_000, 60).due.map((m) => m.gameId), ['mnf'])
})

test('shouldHandOff waits out a close that is about to fire, within the hard cap', () => {
  const cfg = { maxRuntimeSeconds: 19_500, quietSeconds: 900, hardCapSeconds: 20_700 }
  const now = T - 3600_000
  assert.equal(shouldHandOff({ ...cfg, elapsedSeconds: 19_000, nextCloseAtMs: null, nowMs: now }), false)
  assert.equal(shouldHandOff({ ...cfg, elapsedSeconds: 19_600, nextCloseAtMs: null, nowMs: now }), true)
  assert.equal(shouldHandOff({ ...cfg, elapsedSeconds: 19_600, nextCloseAtMs: now + 600_000, nowMs: now }), false)
  assert.equal(shouldHandOff({ ...cfg, elapsedSeconds: 19_600, nextCloseAtMs: now + 1_800_000, nowMs: now }), true)
  assert.equal(shouldHandOff({ ...cfg, elapsedSeconds: 20_700, nextCloseAtMs: now + 60_000, nowMs: now }), true)
})

test('parseCsv reads gameDate and status by gameId, tolerating CRLF and blank rows', () => {
  const csv = 'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved\r\n' +
    'NFL-2026-09-28-HOME-Bears-AWAY-Eagles,NFL,Bears,Eagles,2026-09-29T00:15:00Z,open,0x4F71,,2026-09-22T12:00:00Z,week 3,yes\r\n,,,,,,,,,,\n'
  const rows = parseCsv(csv)
  assert.equal(rows.size, 1)
  assert.deepEqual(rows.get('NFL-2026-09-28-HOME-Bears-AWAY-Eagles'), { gameDate: '2026-09-29T00:15:00Z', status: 'open' })
})
