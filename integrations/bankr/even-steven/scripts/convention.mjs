// The sign convention, stated twice so the two can be checked against each other.
//
// The contract (SportsbookMarket v1.11): a HOME bet (greaterThan true) wins iff finalSpread * 10000 > lockedZ;
// an AWAY bet (greaterThan false) wins iff finalSpread * 10000 <= lockedZ. finalSpread = home score - away score.
export function contractWins(lockedZ, side, finalSpread) {
  const lhs = BigInt(finalSpread) * 10_000n
  return side === 'home' ? lhs > BigInt(lockedZ) : lhs <= BigInt(lockedZ)
}

/**
 * Reads one of the skill's win-condition sentences ("Cowboys -3.5: you win if the Cowboys win by 4 or more") and
 * returns the predicate it states, as a function of the final spread (home minus away). It parses the printed words,
 * so it checks what the user is actually told, not the code that produced it.
 */
export function sentenceWins(sentence, side, finalSpread) {
  const m = /you win if the .+? (win by (\d+) or more|win outright|win or tie|win, tie, or lose by 1|win, tie, or lose by up to (\d+))$/.exec(sentence)
  if (!m) throw new Error('unparseable sentence: ' + sentence)
  let need   // the smallest margin, in the team's own favour, that wins
  if (m[2]) need = Number(m[2])
  else if (m[1] === 'win outright') need = 1
  else if (m[1] === 'win or tie') need = 0
  else if (m[1] === 'win, tie, or lose by 1') need = -1
  else need = -Number(m[3])
  const margin = side === 'home' ? Number(finalSpread) : -Number(finalSpread)   // the team's own margin
  return margin >= need
}
