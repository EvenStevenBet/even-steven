// node --test scripts/kickoff-closer.test.mjs
import fs from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advances, chainStatus, exitCodeFor, outcome, parseCsv, parseGameDate, plan, reconcileCandidates, runPass,
  shouldHandOff, shouldReconcile,
} from './kickoff-closer.mjs'

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
  assert.deepEqual(rows.get('NFL-2026-09-28-HOME-Bears-AWAY-Eagles'), { gameDate: '2026-09-29T00:15:00Z', status: 'open', marketAddress: '0x4F71' })
})

// ── CSV status reconcile ──────────────────────────────────────────────────────
const A = '0xECdE7BCd697978b19880990964e8D9Eb09ACfb75'
const B = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26'
const C = '0x1162dc28Ba0B33C89D7d50025D783d3476f7bBB9'

test('advances: statuses only move forward, terminal ones never change', () => {
  assert.equal(advances('open', 'closed'), true)
  assert.equal(advances('open', 'settled'), true)
  assert.equal(advances('closed', 'settled'), true)
  assert.equal(advances('closed', 'closed'), false)
  assert.equal(advances('settled', 'closed'), false)
  assert.equal(advances('refund', 'settled'), false)
  assert.equal(advances('coming_soon', 'closed'), false) // not this script's row to touch
})

test('chainStatus maps on-chain flags; a canceled market is left to a human', () => {
  assert.equal(chainStatus({ bettingOpen: true, settled: false, canceled: false }), 'open')
  assert.equal(chainStatus({ bettingOpen: false, settled: false, canceled: false }), 'closed')
  assert.equal(chainStatus({ bettingOpen: false, settled: true, canceled: false }), 'settled')
  assert.equal(chainStatus({ bettingOpen: false, settled: false, canceled: true }), 'cancelled_or_refund')
})

test('reconcileCandidates: open/closed rows with an address whose market is not open on chain', () => {
  const rows = new Map([
    ['open-row', { status: 'open', marketAddress: A }],
    ['still-open', { status: 'open', marketAddress: B }],
    ['closed-row', { status: 'closed', marketAddress: C }],
    ['settled-row', { status: 'settled', marketAddress: A }],
    ['no-address', { status: 'open', marketAddress: '' }],
  ])
  assert.deepEqual(reconcileCandidates(rows, [B.toLowerCase()]).map((r) => r.gameId), ['open-row', 'closed-row'])
})

// ── runPass with fake I/O ─────────────────────────────────────────────────────
function fakeIo({ nowMs, csv, open = [], states = {}, failRead = false, failWrite = () => false }) {
  const events = []
  let now = nowMs
  return {
    events,
    advance: (ms) => { now += ms },
    io: {
      now: () => now,
      readCsvText: async () => { if (failRead) throw new Error('GitHub contents GET 503'); return csv },
      openOwnedMarkets: async () => open.map((m) => ({ ...m })),
      closeOne: async (m) => { events.push(`close ${m.gameId}`); return true },
      marketState: async (address) => states[address],
      writeStatus: async (gameId, status) => {
        events.push(`write ${gameId} ${status}`)
        if (failWrite(gameId)) throw new Error('GitHub contents PUT 500')
      },
      log: (event, fields) => events.push(`log ${event}${fields?.gameId ? ' ' + fields.gameId : ''}`),
    },
  }
}
const HEADER = 'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved\n'
const row = (id, date, status, addr) => `${id},NFL,H,A,${date},${status},${addr},,2026-01-01T00:00:00Z,,yes\n`
const cfg = { leadSeconds: 60, csvMaxAgeMs: 300_000, reconcileQuietMs: 900_000, dryRun: false }

test('(a) every due close is sent before any CSV write, and a failed write touches no close', async () => {
  const csv = HEADER + row('g1', '2026-09-29T00:15:00Z', 'open', A) + row('g2', '2026-09-29T00:15:00Z', 'open', B)
  const f = fakeIo({
    nowMs: T - 30_000, csv,
    open: [{ address: A, gameId: 'g1', gameDateMs: T }, { address: B, gameId: 'g2', gameDateMs: T }],
    failWrite: (id) => id === 'g1',
  })
  const state = { csvRows: new Map(), csvReadAt: 0 }
  const r = await runPass(state, f.io, cfg)
  const firstWrite = f.events.findIndex((e) => e.startsWith('write'))
  assert.deepEqual(f.events.filter((e) => e.startsWith('close')), ['close g1', 'close g2'])
  assert.ok(f.events.lastIndexOf('close g2') < firstWrite, f.events.join(' | '))
  assert.ok(f.events.includes('write g2 closed'), 'a failed write for g1 does not stop the write for g2')
  assert.equal(r.closedCount, 2)
  assert.equal(r.csvFailures, 1)
})

test('(a) a CSV re-read failure keeps the rows in hand and still closes on time', async () => {
  const csv = HEADER + row('g1', '2026-09-29T00:15:00Z', 'open', A)
  const f = fakeIo({ nowMs: T - 3600_000, csv, open: [{ address: A, gameId: 'g1', gameDateMs: T }] })
  const state = { csvRows: new Map(), csvReadAt: 0 }
  await runPass(state, f.io, cfg) // first read succeeds, nothing due yet
  assert.equal(f.events.filter((e) => e.startsWith('close')).length, 0)
  f.io.readCsvText = async () => { throw new Error('GitHub contents GET 503') }
  f.advance(3600_000 - 30_000) // 30s before kickoff, CSV stale and GitHub down
  const r = await runPass(state, f.io, cfg)
  assert.ok(f.events.includes('log csv_read_failed'))
  assert.ok(f.events.includes('close g1'))
  assert.equal(r.closedCount, 1)
})

test('(a) with no CSV ever read, the pass fails rather than guess (the watcher keeps going)', async () => {
  const f = fakeIo({ nowMs: T, csv: '', failRead: true, open: [{ address: A, gameId: 'g1', gameDateMs: null }] })
  await assert.rejects(runPass({ csvRows: new Map(), csvReadAt: 0 }, f.io, cfg), /503/)
  assert.equal(f.events.filter((e) => e.startsWith('close')).length, 0)
})

test('(a) reconcile never runs when a close is due within the quiet window', async () => {
  const csv = HEADER + row('g1', '2026-09-29T00:15:00Z', 'open', A) + row('stale', '2026-09-20T00:15:00Z', 'open', B)
  const f = fakeIo({ nowMs: T - 10 * 60_000, csv, open: [{ address: A, gameId: 'g1', gameDateMs: T }],
    states: { [B]: { bettingOpen: false, settled: true, canceled: false } } })
  await runPass({ csvRows: new Map(), csvReadAt: 0 }, f.io, cfg)
  assert.equal(f.events.filter((e) => e.startsWith('write')).length, 0)
  assert.equal(shouldReconcile(T, T - 10 * 60_000, 900_000), false)
  assert.equal(shouldReconcile(T, T - 20 * 60_000, 900_000), true)
  assert.equal(shouldReconcile(null, T, 900_000), true)
})

test('reconcile writes the on-chain state, flags a canceled market, never moves a row back', async () => {
  const D = '0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9'
  const csv = HEADER +
    row('was-open-now-settled', '2026-10-04T20:25:00Z', 'open', A) +
    row('was-closed-now-settled', '2026-09-28T00:15:00Z', 'closed', B) +
    row('open-but-closed', '2026-10-04T17:00:00Z', 'open', C) +
    row('canceled', '2026-10-04T17:00:00Z', 'open', D)
  const f = fakeIo({ nowMs: T, csv, states: {
    [A]: { bettingOpen: false, settled: true, canceled: false },
    [B]: { bettingOpen: false, settled: true, canceled: false },
    [C]: { bettingOpen: false, settled: false, canceled: false },
    [D]: { bettingOpen: false, settled: false, canceled: true },
  } })
  await runPass({ csvRows: new Map(), csvReadAt: 0 }, f.io, cfg)
  assert.deepEqual(f.events.filter((e) => e.startsWith('write')), [
    'write was-open-now-settled settled', 'write was-closed-now-settled settled', 'write open-but-closed closed',
  ])
  assert.ok(f.events.includes('log csv_reconcile_needs_human canceled'))
})

test('dry run reconciles nothing for real', async () => {
  const csv = HEADER + row('x', '2026-10-04T20:25:00Z', 'open', A)
  const f = fakeIo({ nowMs: T, csv, states: { [A]: { bettingOpen: false, settled: true, canceled: false } } })
  await runPass({ csvRows: new Map(), csvReadAt: 0 }, f.io, { ...cfg, dryRun: true })
  assert.equal(f.events.filter((e) => e.startsWith('write')).length, 0)
  assert.ok(f.events.includes('log would_update_status x'))
})

// ── (b) the watch step and the handoff ────────────────────────────────────────
test('(b) a CSV failure never sets the exit code mid-run', async () => {
  const before = process.exitCode
  const csv = HEADER + row('g1', '2026-09-29T00:15:00Z', 'open', A)
  const f = fakeIo({ nowMs: T - 30_000, csv, open: [{ address: A, gameId: 'g1', gameDateMs: T }], failWrite: () => true })
  const r = await runPass({ csvRows: new Map(), csvReadAt: 0 }, f.io, cfg)
  assert.equal(r.csvFailures, 1)
  assert.equal(process.exitCode, before)
})

test('(b) CSV failures fail only the run that ends the watch, never one that hands off', () => {
  assert.equal(exitCodeFor({ rearm: 'true', sawUntimed: false, untimedOnly: false, csvFailures: 3 }), 0)
  assert.equal(exitCodeFor({ rearm: 'false', sawUntimed: false, untimedOnly: false, csvFailures: 1 }), 1)
  assert.equal(exitCodeFor({ rearm: 'false', sawUntimed: false, untimedOnly: false, csvFailures: 0 }), 0)
  assert.equal(exitCodeFor({ rearm: 'true', sawUntimed: true, untimedOnly: false, csvFailures: 0 }), 1) // existing rule
})

test('(b) the handoff step runs even when the watch step fails', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/kickoff-closer.yml', import.meta.url), 'utf8')
  const step = yml.split('- name: Hand off to a fresh watcher')[1]
  assert.ok(step, 'handoff step present')
  assert.match(step.split('\n').find((l) => l.trim().startsWith('if:')), /always\(\) && steps\.watch\.outputs\.rearm == 'true'/)
  assert.match(yml, /- id: watch\n\s+run: node scripts\/kickoff-closer\.mjs/)
})

test('outcome: an untimed market fails the job, but never at the expense of a timed one', () => {
  assert.equal(outcome({ timedRemaining: 1, untimedRemaining: 1, iterationFailed: false }), 'continue')
  assert.equal(outcome({ timedRemaining: 0, untimedRemaining: 1, iterationFailed: false }), 'fail')
  assert.equal(outcome({ timedRemaining: 0, untimedRemaining: 0, iterationFailed: false }), 'done')
  assert.equal(outcome({ timedRemaining: 0, untimedRemaining: 0, iterationFailed: true }), 'continue')
})
