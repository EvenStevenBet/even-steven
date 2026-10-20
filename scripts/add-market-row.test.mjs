// node --test scripts/add-market-row.test.mjs
// Synthetic fixtures only: invented 2031 matchups, not real schedule data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADER, buildRow, canonicalTeam, easternDate, insertRow, parseEastern, parseUtc } from './add-market-row.mjs'

const NOW = Date.parse('2030-06-01T00:00:00Z')
const CSV = HEADER + '\n'
const row = (id, status = 'coming_soon', addr = '') => `${id},NBA,A,B,2031-01-01T00:00:00Z,${status},${addr},,2030-12-31T12:00:00Z,,`

test('parseUtc is strict', () => {
  assert.equal(parseUtc('2031-01-07T00:30:00Z'), Date.parse('2031-01-07T00:30:00Z'))
  for (const bad of ['2031-01-07T00:30:00.000Z', '2031-01-07T00:30:00+00:00', '2031-01-07T00:30Z', '2031-02-30T00:00:00Z', '2031-01-07 00:30:00Z']) {
    assert.throws(() => parseUtc(bad), /strict ISO/, bad)
  }
})

test('parseEastern follows DST both sides of the November change', () => {
  // US DST 2031 ends Sunday Nov 2: before it Eastern is UTC-4, after it UTC-5.
  assert.equal(new Date(parseEastern('2031-10-28 19:30')).toISOString(), '2031-10-28T23:30:00.000Z')
  assert.equal(new Date(parseEastern('2031-11-04T19:30')).toISOString(), '2031-11-05T00:30:00.000Z')
  assert.equal(new Date(parseEastern('2031-03-20 19:00:00')).toISOString(), '2031-03-20T23:00:00.000Z') // after spring-forward (Mar 9)
  assert.throws(() => parseEastern('2031-03-09 02:30'), /not a valid US Eastern time/) // skipped hour
  assert.throws(() => parseEastern('2031-11-02 01:30'), /happens twice/)             // repeated hour
  assert.throws(() => parseEastern('2031-02-30 19:00'), /not a valid/)
  assert.throws(() => parseEastern('7:30pm'), /must look like/)
})

test('easternDate: a late tip is still dated by the Eastern day', () => {
  assert.equal(easternDate(Date.parse('2031-01-07T03:30:00Z')), '2031-01-06')
  assert.equal(easternDate(Date.parse('2031-01-07T05:00:00Z')), '2031-01-07')
})

test('team names: teams.mjs spelling, case and punctuation tolerant, no aliases', () => {
  assert.equal(canonicalTeam('NBA', 'trail-blazers'), 'Trail Blazers')
  assert.equal(canonicalTeam('NBA', 'TrailBlazers'), 'Trail Blazers')
  assert.equal(canonicalTeam('NBA', '76ers'), '76ers')
  assert.throws(() => canonicalTeam('NBA', 'Sixers'), /not a NBA nickname/)
  assert.throws(() => canonicalTeam('NBA', 'Blazers'), /not a NBA nickname/)
  assert.throws(() => canonicalTeam('NBA', 'Chiefs'), /not a NBA nickname/)
})

test('buildRow: an Eastern late tip-off, multi-word and numeric names', () => {
  const { line, gameId, warnings } = buildRow({ sport: 'nba', home: 'Trail Blazers', away: '76ers', et: '2031-01-06 22:30' }, CSV, NOW)
  assert.equal(gameId, 'NBA-2031-01-06-HOME-Trail-Blazers-AWAY-76ers')
  assert.equal(line, 'NBA-2031-01-06-HOME-Trail-Blazers-AWAY-76ers,NBA,Trail Blazers,76ers,2031-01-07T03:30:00Z,coming_soon,,,2031-01-05T12:00:00Z,,')
  assert.equal(line.split(',').length, 11)
  assert.deepEqual(warnings, [])
})

test('buildRow: bettingOpensAt is 12:00Z the day before the Eastern date, across a month and year boundary', () => {
  const { line } = buildRow({ sport: 'NBA', home: 'Jazz', away: 'Heat', utc: '2031-01-01T00:00:00Z', notes: 'synthetic' }, CSV, NOW)
  assert.equal(line, 'NBA-2030-12-31-HOME-Jazz-AWAY-Heat,NBA,Jazz,Heat,2031-01-01T00:00:00Z,coming_soon,,,2030-12-30T12:00:00Z,synthetic,')
})

test('buildRow blocks bad input', () => {
  const base = { sport: 'NBA', home: 'Jazz', away: 'Heat', utc: '2031-01-07T00:00:00Z' }
  assert.throws(() => buildRow({ ...base, sport: 'MLB' }, CSV, NOW), /--sport/)
  assert.throws(() => buildRow({ ...base, away: 'jazz' }, CSV, NOW), /same team/)
  assert.throws(() => buildRow({ ...base, et: '2031-01-06 19:00' }, CSV, NOW), /exactly one/)
  assert.throws(() => buildRow({ ...base, utc: undefined }, CSV, NOW), /exactly one/)
  for (const notes of ['a,b', 'say "hi"', 'café']) assert.throws(() => buildRow({ ...base, notes }, CSV, NOW), /--notes/)
  assert.throws(() => buildRow(base, 'gameId,sport\n', NOW), /header/)
  const dup = CSV + row('NBA-2031-01-06-HOME-Jazz-AWAY-Heat', 'open', '0xabc') + '\n'
  assert.throws(() => buildRow(base, dup, NOW), /already in the file \(status open\)/)
})

test('buildRow warns, without blocking, on a started game or a passed opening time', () => {
  const started = buildRow({ sport: 'NBA', home: 'Jazz', away: 'Heat', utc: '2031-01-07T00:00:00Z' }, CSV, Date.parse('2031-01-07T00:00:00Z'))
  assert.match(started.warnings.join('\n'), /already passed.*game_already_started/)
  const due = buildRow({ sport: 'NBA', home: 'Jazz', away: 'Heat', utc: '2031-01-07T00:00:00Z' }, CSV, Date.parse('2031-01-05T13:00:00Z'))
  assert.match(due.warnings.join('\n'), /bettingOpensAt 2031-01-05T12:00:00Z has already passed/)
})

test('buildRow warns at 2+ live same-sport rows on that Eastern date; settled/cancelled and other dates or sports do not count', () => {
  const args = { sport: 'NBA', home: 'Jazz', away: 'Heat', utc: '2031-01-07T00:00:00Z' }
  const one = CSV + [row('NBA-2031-01-06-HOME-Kings-AWAY-Suns'), row('NBA-2031-01-06-HOME-Nets-AWAY-Bulls', 'settled'),
    row('NBA-2031-01-06-HOME-Magic-AWAY-Hawks', 'cancelled'), row('NBA-2031-01-07-HOME-Bucks-AWAY-Spurs'),
    row('NFL-2031-01-06-HOME-Bills-AWAY-Jets')].join('\n') + '\n'
  assert.deepEqual(buildRow(args, one, NOW).warnings, [])
  const two = one + row('NBA-2031-01-06-HOME-Lakers-AWAY-Clippers', 'open', '0xabc') + '\n'
  const w = buildRow(args, two, NOW).warnings
  assert.equal(w.length, 1)
  assert.match(w[0], /2031-01-06 \(Eastern\) already has 2 NBA rows/)
  assert.match(w[0], /Kings-AWAY-Suns \[coming_soon\].*Lakers-AWAY-Clippers \[open\]/)
})

test('insertRow goes after the last data row and keeps trailing blank rows and line numbers', () => {
  const text = [HEADER, 'r1,,,,,,,,,,', 'r2,,,,,,,,,,', '', '', ''].join('\n')
  assert.equal(insertRow(text, 'NEW'), [HEADER, 'r1,,,,,,,,,,', 'r2,,,,,,,,,,', 'NEW', '', '', ''].join('\n'))
  assert.equal(insertRow(HEADER + '\n', 'NEW'), HEADER + '\nNEW\n')
  assert.equal(insertRow(HEADER, 'NEW'), HEADER + '\nNEW')
})
