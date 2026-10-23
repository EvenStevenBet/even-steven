// Copy lint for the skill text. No behavior; it only reads files. Used by the Bankr skill's tests and by the OpenClaw skill's tests.
//
// What is linted: SKILL.md, README.md, catalog.json, references/*.md, and every string literal in scripts/even-steven.mjs (the text
// the script prints). Comments and identifiers are not linted. SKILL.md is bettor-facing and gets the stricter second list.
import fs from 'node:fs'
import path from 'node:path'

const APPROVED_PITCH = 'Bet even-odds! Back either side at even money. The spread moves to balance the pool, so $100 wins $100. Get in early and lock a better spread than the crowd gets later. Flat 2% of your bet. Nothing else. No overround, no margin in the odds, no house betting against you.'
const APPROVED_SENTENCE_1 = 'Back either side at even money. The spread moves to balance the pool, so $100 wins $100.'
export const APPROVED = [APPROVED_PITCH, APPROVED_SENTENCE_1]

// Words and phrases that must not appear anywhere user-facing. [name, regex].
export const FORBIDDEN = [
  ['settlement fee', /settlement fee/i], ['4% friction', /4% friction/i], ['no fee', /\bno fees?\b/i], ['no vig', /\bno vig\b/i],
  ['no house edge', /no house edge/i], ['no house advantage', /no house advantage/i], ['no house margin', /no house margin/i],
  ['at liquidity', /at liquidity/i], ['liquid market', /liquid market/i], ['balanced market', /balanced market/i], ['mature market', /mature market/i],
  ['Z line', /\bz line\b/i], ['oracleZ', /oracleZ/], ['lockedZ', /lockedZ/], ['guaranteed', /guaranteed/i], ['alpha', /\balpha\b/i],
  ['make more', /\bmake more\b/i], ['airdrop', /airdrop/i], ['half', /\bhalf\b/i], ['em dash', /—/],
  // Builder-code contact wording is fixed: "To ask about a builder code, email ... Jeff approves each one." These older phrasings must not return in any file.
  ['ask for a builder code', /ask for a builder code/i], ['Even Steven approves each builder', /even steven approves each builder/i],
]
// "audited" is only allowed right before ", not a formal third-party audit" or right after "five internal audit rounds".
const AUDITED = /audited/i
// Extra words that must not appear in the bettor-facing SKILL.md (they belong only in the developer README).
export const BETTOR_FORBIDDEN = [['builder code', /builder code/i], ['affiliate', /affiliate/i], ['points', /\bpoints\b/i], ['ES_REF', /ES_REF/], ['ref=', /\bref=/]]

// Explicit, short allowlist: [file suffix, rule name, why]. Empty unless a flagged line is genuinely technical and cannot be reworded.
export const ALLOW = []
// The one structural exemption: string literals that are contract ABI fragments ("function ...", "event ...", "error ..."). They are code,
// never printed, and their field names (for example lockedZ) are read by the script.
export const ABI_FRAGMENT = /^(function|event|error) /

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length
const snippet = (text, idx) => text.slice(Math.max(0, idx - 30), idx + 50).replace(/\s+/g, ' ')

export function lintText(text, label, { bettorFacing = false } = {}) {
  const out = []
  const add = (rule, idx) => { if (!ALLOW.some(([f, r]) => label.endsWith(f) && r === rule)) out.push({ file: label, line: lineOf(text, idx), rule, snippet: snippet(text, idx) }) }
  for (const [name, re] of FORBIDDEN) for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) add(name, m.index)
  for (const m of text.matchAll(/audited/gi)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index), after = text.slice(m.index + m[0].length, m.index + m[0].length + 45)
    if (!(/^, not a formal third-party audit/.test(after) || /five internal audit rounds[^.]*$/.test(before))) add('audited', m.index)
  }
  for (const m of text.matchAll(/\$100 wins \$100/g)) {
    const ok = APPROVED.some((s) => { const i = text.indexOf(s); return i >= 0 && m.index >= i && m.index < i + s.length })
    if (!ok) add('$100 wins $100 outside an approved sentence', m.index)
  }
  if (bettorFacing) for (const [name, re] of BETTOR_FORBIDDEN) for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) add(name + ' (bettor-facing)', m.index)
  return out
}

/** String literals of a JS file (single, double, and template text), skipping comments and regex literals. Returns [{text, index}]. */
export function stringLiterals(src) {
  const out = []; let i = 0; let prev = ''
  const regexOk = () => /[(,=:\[!&|?{};]$|^$|return$/.test(prev)
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue }
    if (c === '/' && regexOk()) { i++; let cls = false; while (i < src.length && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++ } i++; while (/[a-z]/.test(src[i] || '')) i++; prev = 'x'; continue }
    if (c === '"' || c === "'") { const s = i; i++; let t = ''; while (i < src.length && src[i] !== c) { if (src[i] === '\\') { t += src[i + 1]; i += 2 } else t += src[i++] } out.push({ text: t, index: s }); i++; prev = 'x'; continue }
    if (c === '`') { const s = i; i++; let t = ''; let depth = 0
      while (i < src.length && !(src[i] === '`' && depth === 0)) {
        if (src[i] === '\\') { t += src[i + 1]; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; t += ' '; i += 2; continue }
        if (depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; continue }
        t += src[i++]
      }
      out.push({ text: t, index: s }); i++; prev = 'x'; continue }
    if (!/\s/.test(c)) prev = (prev + c).slice(-6)
    i++
  }
  return out
}

/** All user-facing files of a skill folder as [{label, text, bettorFacing}]. */
export function userFacing(dir) {
  const files = []
  const add = (rel, extra = {}) => { const p = path.join(dir, rel); if (fs.existsSync(p)) files.push({ label: rel, text: fs.readFileSync(p, 'utf8'), ...extra }) }
  add('SKILL.md', { bettorFacing: true }); add('README.md'); add('catalog.json')
  const refs = path.join(dir, 'references')
  if (fs.existsSync(refs)) for (const f of fs.readdirSync(refs).filter((x) => x.endsWith('.md')).sort()) add(path.join('references', f))
  const script = path.join(dir, 'scripts', 'even-steven.mjs')
  if (fs.existsSync(script)) { const src = fs.readFileSync(script, 'utf8'); files.push({ label: 'scripts/even-steven.mjs (printed strings)', text: stringLiterals(src).map((s) => s.text).filter((t) => !ABI_FRAGMENT.test(t)).join('\n') }) }
  return files
}

export function lintSkill(dir) {
  return userFacing(dir).flatMap((f) => lintText(f.text, f.label, { bettorFacing: !!f.bettorFacing }))
}
export const format = (v) => v.map((x) => `${x.file}:${x.line} [${x.rule}] ...${x.snippet}...`).join('\n')
