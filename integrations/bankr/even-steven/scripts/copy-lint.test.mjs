// Copy lint tests. Lints this skill, and the OpenClaw skill too when it sits next to it (it does on the integrations/openclaw branch).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintText, lintSkill, stringLiterals, userFacing, format, FORBIDDEN, BETTOR_FORBIDDEN, APPROVED, ALLOW } from './copy-lint.mjs'

const dir = fileURLToPath(new URL('..', import.meta.url))
const other = path.resolve(dir, '../../openclaw/even-steven')

test('copy lint: the Bankr skill (SKILL.md, README.md, catalog.json, references, printed strings) has no violations', () => {
  const v = lintSkill(dir); assert.equal(v.length, 0, '\n' + format(v))
})
test('copy lint: the OpenClaw skill has no violations (when present next to this one)', { skip: !fs.existsSync(other) }, () => {
  const v = lintSkill(other); assert.equal(v.length, 0, '\n' + format(v))
})
test('copy lint covers every user-facing file', () => {
  const labels = userFacing(dir).map((f) => f.label)
  for (const need of ['SKILL.md', 'README.md', 'catalog.json', 'references/relay-errors.md', 'references/checks.md', 'references/runtime.md', 'scripts/even-steven.mjs (printed strings)']) assert.ok(labels.includes(need), need)
  assert.equal(userFacing(dir).find((f) => f.label === 'SKILL.md').bettorFacing, true)
  assert.ok(userFacing(dir).find((f) => f.label.startsWith('scripts/')).text.length > 3000, 'printed strings were extracted')
})
test('copy lint: the allowlist is empty (every term is enforced everywhere)', () => { assert.deepEqual(ALLOW, []) })

// ---- the rules themselves ----
const hits = (t, opts) => lintText(t, 'x.md', opts).map((h) => h.rule)
test('copy lint rules: every forbidden term is caught', () => {
  const samples = { 'settlement fee': 'There is a settlement fee.', '4% friction': 'a 4% friction model', 'no fee': 'it has no fee', 'no vig': 'no vig here', 'no house edge': 'no house edge',
    'no house advantage': 'no house advantage', 'no house margin': 'no house margin', 'at liquidity': 'pays 2x at liquidity', 'liquid market': 'a liquid market', 'balanced market': 'a balanced market',
    'mature market': 'a mature market', 'Z line': 'the Z line moves', oracleZ: 'set oracleZ', lockedZ: 'your lockedZ', guaranteed: 'guaranteed win', alpha: 'real alpha', 'make more': 'helps you make more',
    airdrop: 'an airdrop', half: 'half the pool', 'em dash': 'one — two',
    'ask for a builder code': 'To ask for a builder code, email us.', 'Even Steven approves each builder': 'Even Steven approves each builder.',
    'lock a better': 'lock a better price', 'better spread': 'a better spread than the crowd', 'better line': 'you get a better line', 'early bettors': 'early bettors win',
    'get in early': 'Get in early.', 'always free': 'it is always free' }
  for (const [name] of FORBIDDEN) { assert.ok(samples[name], 'sample for ' + name); assert.ok(hits(samples[name]).includes(name), name + ' not caught in: ' + samples[name]) }
})
test('copy lint rules: the old builder-contact wording is rejected in every file, and the approved line is not', () => {
  for (const bad of ['To ask for a builder code, email evenstevenbet@gmail.com.', 'Even Steven approves each builder.', 'TO ASK FOR A BUILDER CODE'])
    for (const opts of [{}, { bettorFacing: true }]) assert.ok(hits(bad, opts).some((r) => r === 'ask for a builder code' || r === 'Even Steven approves each builder'), bad)
  assert.ok(FORBIDDEN.some(([n]) => n === 'ask for a builder code') && FORBIDDEN.some(([n]) => n === 'Even Steven approves each builder'), 'in the all-files list, not only the bettor-facing one')
  assert.deepEqual(hits('To ask about a builder code, email evenstevenbet@gmail.com. Jeff approves each one.'), [])
  for (const f of userFacing(dir)) assert.ok(!/ask for a builder code|even steven approves each builder/i.test(f.text), f.label + ' still has the old wording')
})
test('copy lint rules: the nine promise phrases are rejected in any casing, in every file type', () => {
  const phrases = ['lock a better', 'better spread', 'better line', 'early bettors', 'get in early', 'settlement fee', '4% friction', 'guaranteed', 'always free']
  for (const phrase of phrases) for (const text of [phrase, phrase.toUpperCase(), `Intro. ${phrase[0].toUpperCase()}${phrase.slice(1)}, and more.`]) for (const opts of [{}, { bettorFacing: true }]) {
    assert.ok(hits(text, opts).some((r) => r === phrase), `${phrase} not caught in: ${text}`)
  }
  assert.deepEqual(hits('The line locks when your bet lands. Later bets can move the line for later bets.'), [], 'the plain lock wording is allowed')
  for (const f of userFacing(dir)) for (const phrase of phrases) assert.ok(!new RegExp(phrase, 'i').test(f.text), `${f.label} contains "${phrase}"`)
})
test('copy lint rules: near misses are not flagged', () => {
  assert.deepEqual(hits('on behalf of someone; alphabet; a half-court shot is not here'.replace('half-court', 'halftime')), [])
  assert.deepEqual(hits('a flat 2% fee on your stake, paid upfront. Nothing is taken at settlement. Balanced pools pay even money.'), [])
})
test('copy lint rules: "audited" only next to the approved audit wording', () => {
  assert.deepEqual(hits('It is audited, not a formal third-party audit.'), [])
  assert.deepEqual(hits('It has five internal audit rounds and was audited internally.'), [])
  assert.ok(hits('Audited by Claude').includes('audited')); assert.ok(hits('fully audited').includes('audited'))
})
test('copy lint rules: "$100 wins $100" only inside the approved sentences', () => {
  for (const s of APPROVED) assert.deepEqual(hits(s), [], s)
  assert.deepEqual(hits('Intro. ' + APPROVED[0] + ' More.'), [])
  assert.ok(hits('Bet $100 and $100 wins $100 for you.').some((r) => r.startsWith('$100 wins $100')))
  assert.ok(hits(APPROVED[1] + ' Also $100 wins $100 again.').some((r) => r.startsWith('$100 wins $100')))
})
test('copy lint rules: bettor-facing text also rejects builder code, affiliate, points, ES_REF and ref=', () => {
  const samples = { 'builder code': 'ask for a builder code', affiliate: 'an affiliate link', points: 'earn points', ES_REF: 'set ES_REF', 'ref=': 'a link with ref=abc' }
  for (const [name] of BETTOR_FORBIDDEN) { assert.ok(hits(samples[name], { bettorFacing: true }).includes(name + ' (bettor-facing)'), name); assert.ok(!hits(samples[name]).includes(name + ' (bettor-facing)'), name + ' is allowed outside SKILL.md') }
})
test('copy lint: the string-literal scanner reads strings and skips comments, regexes and identifiers', () => {
  const src = "const a = 'one'; // 'not this'\n/* 'nor this' */ const r = /['\"]x/g; const b = \"two\"; const c = `three ${x + 'inner'} four`; const lockedZ = 1"
  const t = stringLiterals(src).map((s) => s.text)
  assert.ok(t.includes('one') && t.includes('two') && t.some((x) => x.includes('three') && x.includes('four')))
  assert.ok(!t.some((x) => x.includes('not this') || x.includes('nor this')))
  assert.ok(!t.join(' ').includes('lockedZ'), 'identifiers are not strings')
})
test('copy lint: ABI fragments are the only exempt strings, and only because they are never printed', () => {
  const src = fs.readFileSync(path.join(dir, 'scripts/even-steven.mjs'), 'utf8')
  const exempt = stringLiterals(src).filter((s) => /^(function|event|error) /.test(s.text) && FORBIDDEN.concat(BETTOR_FORBIDDEN).some(([, re]) => re.test(s.text)))
  assert.ok(exempt.length >= 1 && exempt.every((s) => /lockedZ/.test(s.text)), 'only the getBet fragment needs the exemption')
})
