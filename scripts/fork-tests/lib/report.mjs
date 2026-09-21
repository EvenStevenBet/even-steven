let pass = 0, fail = 0, stops = []
export const results = []

export function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else      { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`) }
  results.push({ name, pass: !!cond, detail })
  return !!cond
}
export function eq(name, a, b, detail = '') {
  const sa = typeof a === 'bigint' ? a.toString() : JSON.stringify(a, (_, v) => typeof v === 'bigint' ? v.toString() : v)
  const sb = typeof b === 'bigint' ? b.toString() : JSON.stringify(b, (_, v) => typeof v === 'bigint' ? v.toString() : v)
  return ok(name, sa === sb, sa === sb ? (detail || sa) : `expected ${sb}, got ${sa}${detail ? ' — ' + detail : ''}`)
}
export function section(t) { console.log('\n' + '─'.repeat(78) + '\n' + t + '\n' + '─'.repeat(78)) }
export function stop(reason) { stops.push(reason); console.log(`  *** STOP *** ${reason}`) }
export function summary() {
  console.log('\n' + '='.repeat(78))
  console.log(`TOTAL: ${pass} passed, ${fail} failed, ${stops.length} stop condition(s)`)
  for (const s of stops) console.log('  STOP: ' + s)
  console.log('='.repeat(78))
  return { pass, fail, stops }
}
