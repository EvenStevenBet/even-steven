// Copy lint for the OpenClaw skill text. The lint itself lives with the Bankr skill (scripts/copy-lint.mjs) and is shared.
// The OpenClaw bundle is built from the Bankr script source, so the strings the script prints are linted from that source.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintSkill, lintText, userFacing, format } from '../../../bankr/even-steven/scripts/copy-lint.mjs'

const dir = fileURLToPath(new URL('..', import.meta.url))
const bankr = path.resolve(dir, '../../bankr/even-steven')

test('copy lint: the OpenClaw skill (SKILL.md, README.md, references) has no violations', () => {
  const v = lintSkill(dir); assert.equal(v.length, 0, '\n' + format(v))
  const labels = userFacing(dir).map((f) => f.label)
  for (const need of ['SKILL.md', 'README.md', 'references/relay-errors.md', 'references/checks.md', 'references/runtime.md']) assert.ok(labels.includes(need), need)
  assert.equal(userFacing(dir).find((f) => f.label === 'SKILL.md').bettorFacing, true)
})
test('copy lint: the Bankr skill, whose script source the OpenClaw bundle is built from, also has no violations', () => {
  const v = lintSkill(bankr); assert.equal(v.length, 0, '\n' + format(v))
  assert.ok(userFacing(bankr).some((f) => f.label.startsWith('scripts/even-steven.mjs')), 'the printed strings are linted')
})
test('copy lint: a bad line in an OpenClaw-style SKILL.md is caught (the lint is live here)', () => {
  const t = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  assert.deepEqual(lintText(t, 'SKILL.md', { bettorFacing: true }), [])
  const bad = t + '\nBuilders earn points — there is a settlement fee at liquidity, audited by someone. Half is guaranteed. ref=abc ES_REF\n'
  const rules = lintText(bad, 'SKILL.md', { bettorFacing: true }).map((h) => h.rule)
  for (const r of ['em dash', 'settlement fee', 'at liquidity', 'audited', 'half', 'guaranteed', 'points (bettor-facing)', 'ref= (bettor-facing)', 'ES_REF (bettor-facing)']) assert.ok(rules.includes(r), r)
})
