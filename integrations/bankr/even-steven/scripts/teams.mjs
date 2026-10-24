// Team aliases for NFL and NBA, so "SF", "Niners", "San Francisco" and "49ers" all mean the 49ers.
// [sport, nickname as it appears in a gameId, city/region words, abbreviations, other nicknames]
const T = [
  ['NFL', 'Cardinals', ['Arizona'], ['ARI'], ['Cards']], ['NFL', 'Falcons', ['Atlanta'], ['ATL'], []], ['NFL', 'Ravens', ['Baltimore'], ['BAL', 'BLT'], []],
  ['NFL', 'Bills', ['Buffalo'], ['BUF'], []], ['NFL', 'Panthers', ['Carolina'], ['CAR'], []], ['NFL', 'Bears', ['Chicago'], ['CHI'], []],
  ['NFL', 'Bengals', ['Cincinnati'], ['CIN'], []], ['NFL', 'Browns', ['Cleveland'], ['CLE'], []], ['NFL', 'Cowboys', ['Dallas'], ['DAL'], []],
  ['NFL', 'Broncos', ['Denver'], ['DEN'], []], ['NFL', 'Lions', ['Detroit'], ['DET'], []], ['NFL', 'Packers', ['Green Bay'], ['GB', 'GNB'], []],
  ['NFL', 'Texans', ['Houston'], ['HOU'], []], ['NFL', 'Colts', ['Indianapolis'], ['IND'], []], ['NFL', 'Jaguars', ['Jacksonville'], ['JAX', 'JAC'], ['Jags']],
  ['NFL', 'Chiefs', ['Kansas City'], ['KC', 'KAN'], []], ['NFL', 'Raiders', ['Las Vegas'], ['LV', 'LVR', 'OAK'], []],
  ['NFL', 'Chargers', ['Los Angeles', 'LA'], ['LAC'], []], ['NFL', 'Rams', ['Los Angeles', 'LA'], ['LAR'], []],
  ['NFL', 'Dolphins', ['Miami'], ['MIA'], ['Fins', 'Phins']], ['NFL', 'Vikings', ['Minnesota'], ['MIN'], []], ['NFL', 'Patriots', ['New England'], ['NE', 'NWE'], ['Pats']],
  ['NFL', 'Saints', ['New Orleans'], ['NO', 'NOR', 'NOLA'], []], ['NFL', 'Giants', ['New York', 'NY'], ['NYG'], ['Big Blue']], ['NFL', 'Jets', ['New York', 'NY'], ['NYJ'], []],
  ['NFL', 'Eagles', ['Philadelphia'], ['PHI'], []], ['NFL', 'Steelers', ['Pittsburgh'], ['PIT'], []], ['NFL', '49ers', ['San Francisco'], ['SF', 'SFO'], ['Niners']],
  ['NFL', 'Seahawks', ['Seattle'], ['SEA'], []], ['NFL', 'Buccaneers', ['Tampa Bay', 'Tampa'], ['TB', 'TAM'], ['Bucs']],
  ['NFL', 'Titans', ['Tennessee'], ['TEN'], []], ['NFL', 'Commanders', ['Washington'], ['WAS', 'WSH', 'WFT'], []],
  ['NBA', 'Hawks', ['Atlanta'], ['ATL'], []], ['NBA', 'Celtics', ['Boston'], ['BOS'], []], ['NBA', 'Nets', ['Brooklyn'], ['BKN', 'BRK'], []],
  ['NBA', 'Hornets', ['Charlotte'], ['CHA', 'CHO'], []], ['NBA', 'Bulls', ['Chicago'], ['CHI'], []], ['NBA', 'Cavaliers', ['Cleveland'], ['CLE'], ['Cavs']],
  ['NBA', 'Mavericks', ['Dallas'], ['DAL'], ['Mavs']], ['NBA', 'Nuggets', ['Denver'], ['DEN'], []], ['NBA', 'Pistons', ['Detroit'], ['DET'], []],
  ['NBA', 'Warriors', ['Golden State'], ['GS', 'GSW'], ['Dubs']], ['NBA', 'Rockets', ['Houston'], ['HOU'], []], ['NBA', 'Pacers', ['Indiana'], ['IND'], []],
  ['NBA', 'Clippers', ['Los Angeles', 'LA'], ['LAC'], []], ['NBA', 'Lakers', ['Los Angeles', 'LA'], ['LAL'], []], ['NBA', 'Grizzlies', ['Memphis'], ['MEM'], []],
  ['NBA', 'Heat', ['Miami'], ['MIA'], []], ['NBA', 'Bucks', ['Milwaukee'], ['MIL'], []], ['NBA', 'Timberwolves', ['Minnesota'], ['MIN'], ['Wolves', 'T-Wolves']],
  ['NBA', 'Pelicans', ['New Orleans'], ['NO', 'NOP'], ['Pels']], ['NBA', 'Knicks', ['New York', 'NY'], ['NYK'], []], ['NBA', 'Thunder', ['Oklahoma City'], ['OKC'], []],
  ['NBA', 'Magic', ['Orlando'], ['ORL'], []], ['NBA', '76ers', ['Philadelphia'], ['PHI', 'PHL'], ['Sixers']], ['NBA', 'Suns', ['Phoenix'], ['PHX', 'PHO'], []],
  ['NBA', 'Trail Blazers', ['Portland'], ['POR'], ['Blazers']], ['NBA', 'Kings', ['Sacramento'], ['SAC'], []], ['NBA', 'Spurs', ['San Antonio'], ['SA', 'SAS'], []],
  ['NBA', 'Raptors', ['Toronto'], ['TOR'], []], ['NBA', 'Jazz', ['Utah'], ['UTA'], []], ['NBA', 'Wizards', ['Washington'], ['WAS', 'WSH'], []],
]

// Abbreviations that are also ordinary English words are only taken when written in capitals.
const WORDS = new Set(['no', 'was', 'car', 'ten', 'den', 'pit', 'min', 'ind', 'sea', 'det'])
export const TEAMS = T.map(([sport, nick, cities, abbrs, alts]) => ({ sport, nick, key: nick.toLowerCase().replace(/[^a-z0-9]/g, ''), cities, abbrs, alts }))

const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// phrase -> list of { team, kind } where kind is 'nick' | 'city' | 'abbr'
const PHRASES = new Map()
const add = (phrase, team, kind) => { const k = clean(phrase); if (!PHRASES.has(k)) PHRASES.set(k, []); PHRASES.get(k).push({ team, kind }) }
for (const t of TEAMS) {
  add(t.nick, t, 'nick'); for (const a of t.alts) add(a, t, 'nick')
  for (const c of t.cities) add(c, t, 'city'); for (const a of t.abbrs) add(a, t, 'abbr')
}
const MAX_WORDS = Math.max(...[...PHRASES.keys()].map((k) => k.split(' ').length))

/**
 * Finds team references in free text. `sports` is the set of sports present in the markets being searched, so a city that is
 * only ambiguous across sports is not ambiguous when only one sport is on the board.
 * Returns { refs: [{ phrase, teams: [team...] }], rest: [unconsumed tokens] }.
 */
export function findTeamRefs(text, sports) {
  const orig = String(text).replace(/[^A-Za-z0-9'\- ]+/g, ' ').split(/\s+/).filter(Boolean)
  const toks = orig.map((t) => clean(t))
  const refs = [], rest = []
  let i = 0
  while (i < toks.length) {
    let hit = null
    for (let n = Math.min(MAX_WORDS, toks.length - i); n >= 1 && !hit; n--) {
      const phrase = toks.slice(i, i + n).join(' ')
      const entries = PHRASES.get(phrase)
      if (!entries) continue
      if (n === 1 && entries.every((e) => e.kind === 'abbr') && WORDS.has(phrase) && orig[i] !== orig[i].toUpperCase()) continue
      const teams = entries.filter((e) => !sports || sports.has(e.team.sport)).map((e) => e.team)
      if (teams.length) hit = { n, phrase, teams: [...new Set(teams)] }
    }
    if (hit) { refs.push({ phrase: orig.slice(i, i + hit.n).join(' '), teams: hit.teams }); i += hit.n } else { rest.push(toks[i]); i++ }
  }
  return { refs, rest }
}
