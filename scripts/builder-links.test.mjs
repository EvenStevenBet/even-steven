// node --test scripts/builder-links.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedBuilders, linksFor, lines, openMarkets } from './builder-links.mjs'

const ADDR = '0x' + 'a'.repeat(40)

test('only approved builders with a valid code and payout address', () => {
  const rows = [
    { code: 'Alice-Picks', payoutAddress: ADDR, approved: true },
    { code: 'bob', payoutAddress: ADDR, approved: false },
    { code: 'carol', payoutAddress: 'not-an-address', approved: true },
    { code: 'x', payoutAddress: ADDR, approved: true },
    { code: 'dave', payoutAddress: ADDR },
    { code: 'erin', payoutAddress: ADDR, approved: 'true' },
  ]
  assert.deepEqual(approvedBuilders(rows).map(b => b.code), ['alice-picks'])
  assert.deepEqual(approvedBuilders([]), [])
  assert.throws(() => approvedBuilders({}))
})

test('open markets need status open and a market address', () => {
  const csv = [
    'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved',
    `NFL-2026-10-18-HOME-Packers-AWAY-Cowboys,NFL,Packers,Cowboys,2026-10-19T00:20:00Z,open,${ADDR},,x,,yes\r`,
    `NFL-2026-10-12-HOME-Rams-AWAY-Bills,NFL,Rams,Bills,2026-10-13T00:15:00Z,closed,${ADDR},,x,,yes`,
    'NFL-2026-10-26-HOME-Eagles-AWAY-Cowboys,NFL,Eagles,Cowboys,2026-10-27T00:15:00Z,open,,,x,,',
    'NFL-2026-10-27-HOME-A-AWAY-B,NFL,A,B,2026-10-28T00:00:00Z,coming_soon,,,x,,',
  ].join('\n')
  assert.deepEqual(openMarkets(csv).map(m => m.gameId), ['NFL-2026-10-18-HOME-Packers-AWAY-Cowboys'])
})

test('links carry ref and the two side variants', () => {
  assert.deepEqual(linksFor('https://evensteven.bet/', 'NFL-2026-10-18-HOME-Packers-AWAY-Cowboys', 'alice'), {
    any: 'https://evensteven.bet/market/NFL-2026-10-18-HOME-Packers-AWAY-Cowboys?ref=alice',
    home: 'https://evensteven.bet/market/NFL-2026-10-18-HOME-Packers-AWAY-Cowboys?ref=alice&side=home',
    away: 'https://evensteven.bet/market/NFL-2026-10-18-HOME-Packers-AWAY-Cowboys?ref=alice&side=away',
  })
})

test('one line per builder per market', () => {
  const out = lines('https://evensteven.bet', [{ code: 'a1x' }, { code: 'b2y' }],
    [{ gameId: 'G1' }, { gameId: 'G2' }])
  assert.equal(out.length, 4)
  assert.match(out[0], /^a1x\tG1\tany: .*\thome: .*side=home\taway: .*side=away$/)
})
