// Row adder for data/markets.csv — builds one validated 11-column row for a game Jeff has
// confirmed against two official pages, and prints it. Never pushes, never touches git: with
// --write it appends the row to a local working copy, and Jeff reviews and commits it himself.
//
// Usage:
//   node scripts/add-market-row.mjs --sport NBA --home Knicks --away 76ers --utc 2031-01-07T00:30:00Z
//   node scripts/add-market-row.mjs --sport NBA --home "Trail Blazers" --away Jazz --et "2031-01-06 22:00"
//   options: --notes "<text>"   --file <path> (default data/markets.csv)   --write
//
// What it fills in:
//   gameId          SPORT-YYYY-MM-DD-HOME-<Home>-AWAY-<Away>, dated by the US Eastern calendar date of
//                   tip-off; spaces in a nickname become hyphens (the site's parseGameId turns them back)
//   gameDate        tip-off, strict ISO in UTC with Z (from --utc, or converted from --et, DST-aware)
//   status          coming_soon; marketAddress, openLine and approved are left empty (Jeff types approval)
//   bettingOpensAt  12:00:00Z on the day before the Eastern game date
//
// Blocks on: unknown sport or team, same team twice, a bad or non-existent time, a gameId already in
// the file, a value containing a comma, quote or non-ASCII character, or a file header that is not
// the 11-column header the opener bot and kickoff closer read by position.
// Warns (stderr) on: tip-off already passed, bettingOpensAt already passed (the opener treats the row
// as due the moment it is approved), and 2+ rows of the same sport on that Eastern date that are not
// settled or cancelled (the 2-markets-a-day limit).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCsv } from './kickoff-closer.mjs'

export const HEADER = 'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved'
const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/markets.csv')

// Nicknames exactly as integrations/bankr/even-steven/scripts/teams.mjs spells them (the alias table the
// Bankr skill matches gameIds against). Aliases like "Sixers" or "Blazers" are deliberately not accepted.
export const TEAMS = {
  NBA: ['Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons', 'Warriors',
    'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves', 'Pelicans', 'Knicks',
    'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards'],
  NFL: ['Cardinals', 'Falcons', 'Ravens', 'Bills', 'Panthers', 'Bears', 'Bengals', 'Browns', 'Cowboys', 'Broncos',
    'Lions', 'Packers', 'Texans', 'Colts', 'Jaguars', 'Chiefs', 'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings',
    'Patriots', 'Saints', 'Giants', 'Jets', 'Eagles', 'Steelers', '49ers', 'Seahawks', 'Buccaneers', 'Titans', 'Commanders'],
}

const ET = 'America/New_York'
const DAY_MS = 86_400_000
const UTC_STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
const ET_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
const DONE = new Set(['settled', 'cancelled', 'canceled'])

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')

/** Pure. The canonical nickname for `name` in `sport` (case and punctuation ignored), or throws. */
export function canonicalTeam(sport, name) {
  const hit = TEAMS[sport].find((t) => norm(t) === norm(name))
  if (!hit) throw new Error(`"${name}" is not a ${sport} nickname as teams.mjs spells it (e.g. ${TEAMS[sport].slice(0, 3).join(', ')})`)
  return hit
}

/** Pure. "YYYY-MM-DD" US Eastern calendar date of a UTC instant. */
export function easternDate(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

function easternWallClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

/** Pure. Strict "YYYY-MM-DDTHH:MM:SSZ" to ms, or throws (no offsets, no millis, no impossible dates). */
export function parseUtc(value) {
  const m = UTC_STRICT.exec(value)
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN
  if (!m || Number.isNaN(ms) || iso(ms) !== value) throw new Error(`--utc must be strict ISO like 2031-01-07T00:30:00Z, got "${value}"`)
  return ms
}

/**
 * Pure. Eastern wall-clock time ("YYYY-MM-DD HH:MM[:SS]") to a UTC instant. Tries EDT (-4) and EST (-5) and
 * keeps whichever reads back as the same wall clock, so the DST change is handled by the tz database, not by
 * a hand-coded rule. A time that does not exist (spring-forward gap) or happens twice (fall-back hour) throws.
 */
export function parseEastern(value) {
  const m = ET_LOCAL.exec(value)
  if (!m) throw new Error(`--et must look like 2031-01-06 19:30, got "${value}"`)
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  const hits = [4, 5].map((h) => asUtc + h * 3_600_000).filter((ms) => easternWallClock(ms) === wall)
  if (hits.length === 0) throw new Error(`${value} is not a valid US Eastern time (bad date, or skipped by the DST change)`)
  if (hits.length > 1) throw new Error(`${value} happens twice in US Eastern time (DST fall-back); pass --utc instead`)
  return hits[0]
}

/** Pure. Builds and validates the row. existingCsv is the file's text; nowMs drives the warnings only. */
export function buildRow({ sport, home, away, utc, et, notes = '' }, existingCsv, nowMs) {
  sport = String(sport ?? '').toUpperCase()
  if (!TEAMS[sport]) throw new Error(`--sport must be one of ${Object.keys(TEAMS).join(', ')}`)
  if (!home || !away) throw new Error('--home and --away are both required')
  const homeTeam = canonicalTeam(sport, home)
  const awayTeam = canonicalTeam(sport, away)
  if (homeTeam === awayTeam) throw new Error(`home and away are the same team (${homeTeam})`)
  if ((utc == null) === (et == null)) throw new Error('give exactly one of --utc or --et')
  if (/[,"\r\n]|[^\x20-\x7e]/.test(notes)) throw new Error('--notes may not contain commas, quotes, newlines or non-ASCII characters')

  const tipMs = utc != null ? parseUtc(utc) : parseEastern(et)
  const gameDate = iso(tipMs)
  const day = easternDate(tipMs)
  const [y, mo, d] = day.split('-').map(Number)
  const bettingOpensAt = iso(Date.UTC(y, mo - 1, d) - DAY_MS + 12 * 3_600_000)
  const gameId = `${sport}-${day}-HOME-${homeTeam.replace(/ /g, '-')}-AWAY-${awayTeam.replace(/ /g, '-')}`

  // Self-check the invariants the readers rely on, independently of how they were computed above.
  if (easternDate(Date.parse(gameDate)) !== gameId.slice(sport.length + 1, sport.length + 11)) throw new Error('internal: gameId date ≠ Eastern date of gameDate')
  if (!UTC_STRICT.test(bettingOpensAt) || !bettingOpensAt.endsWith('T12:00:00Z')) throw new Error('internal: bad bettingOpensAt')

  const firstLine = existingCsv.split('\n')[0].replace(/\r$/, '')
  if (firstLine !== HEADER) throw new Error(`file header is not the 11-column markets.csv header:\n  got      ${firstLine}\n  expected ${HEADER}`)
  const rows = parseCsv(existingCsv)
  if (rows.has(gameId)) throw new Error(`${gameId} is already in the file (status ${rows.get(gameId).status || 'blank'})`)

  const cols = [gameId, sport, homeTeam, awayTeam, gameDate, 'coming_soon', '', '', bettingOpensAt, notes, '']
  const line = cols.join(',')
  if (cols.length !== 11 || line.split(',').length !== 11 || /["\r\n]|[^\x20-\x7e]/.test(line)) throw new Error('internal: row is not 11 plain ASCII columns')

  const warnings = []
  if (tipMs <= nowMs) warnings.push(`tip-off ${gameDate} has already passed; the opener refuses a started game (game_already_started)`)
  else if (Date.parse(bettingOpensAt) <= nowMs) warnings.push(`bettingOpensAt ${bettingOpensAt} has already passed; the opener treats this row as due as soon as it is approved`)
  const sameDay = [...rows].filter(([id, r]) => id.startsWith(`${sport}-${day}-`) && !DONE.has(r.status.toLowerCase()))
  if (sameDay.length >= 2) {
    warnings.push(`${day} (Eastern) already has ${sameDay.length} ${sport} rows that are not settled or cancelled: ${sameDay.map(([id, r]) => `${id} [${r.status || 'blank'}]`).join(', ')}`)
  }
  return { line, gameId, warnings }
}

/**
 * Pure. The file text with `line` inserted after the last data row, keeping any trailing blank separator
 * rows after it. Earlier rows keep their line numbers, which the opener bot uses to write a row back.
 */
export function insertRow(text, line) {
  const lines = text.split('\n')
  let i = lines.length
  while (i > 1 && lines[i - 1].replace(/\r$/, '').split(',').every((c) => c.trim() === '')) i--
  lines.splice(i, 0, line)
  return lines.join('\n')
}

function parseArgs(argv) {
  const out = { write: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') { out.write = true; continue }
    const key = { '--sport': 'sport', '--home': 'home', '--away': 'away', '--utc': 'utc', '--et': 'et', '--notes': 'notes', '--file': 'file' }[a]
    if (!key || i + 1 >= argv.length) throw new Error(`unknown or incomplete option: ${a}`)
    out[key] = argv[++i]
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = path.resolve(args.file ?? DEFAULT_FILE)
  const text = fs.readFileSync(file, 'utf8')
  const { line, gameId, warnings } = buildRow(args, text, Date.now())
  for (const w of warnings) console.error(`WARNING: ${w}`)
  console.log(line)
  if (args.write) {
    fs.writeFileSync(file, insertRow(text, line))
    console.error(`wrote ${gameId} to ${file} (not committed)`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main() } catch (err) { console.error(`ERROR: ${err.message}`); process.exit(1) }
}
