#!/usr/bin/env node
// Validates a skill folder the way the BankrBot/skills catalog expects. BankrBot/skills has NO validation workflow
// in .github (only CODEOWNERS), so these rules come from its README "Adding a Skill" section and from the shape of
// all 150 catalog.json files currently in that repo (see README.md here for the calibration run).
//
//   node scripts/validate-catalog.mjs [skill-dir ...]     (default: this skill's folder)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load as yamlLoad } from 'js-yaml'

const isStr = (x) => typeof x === 'string' && x.trim().length > 0

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!m) return null
  return yamlLoad(m[1])
}

/** Returns a list of problems (empty = valid). `dir` is the skill folder; its name is the expected slug. */
export function validateSkillDir(dir) {
  const slug = path.basename(path.resolve(dir))
  const errs = []
  const catPath = path.join(dir, 'catalog.json'), skillPath = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(skillPath)) errs.push('SKILL.md is missing')
  else {
    let fm = null
    try { fm = parseFrontmatter(fs.readFileSync(skillPath, 'utf8')) } catch (e) { errs.push('SKILL.md frontmatter is not valid YAML: ' + e.message.split('\n')[0]) }
    if (!fm || typeof fm !== 'object') errs.push('SKILL.md has no YAML frontmatter')
    else {
      if (!isStr(fm.name)) errs.push('SKILL.md frontmatter needs a name')
      if (!isStr(fm.description)) errs.push('SKILL.md frontmatter needs a description (a skill without one is skipped)')
    }
  }
  if (!fs.existsSync(catPath)) { errs.push('catalog.json is missing (a folder without a valid catalog.json is skipped)'); return errs }
  let c
  try { c = JSON.parse(fs.readFileSync(catPath, 'utf8')) } catch (e) { errs.push('catalog.json is not valid JSON: ' + e.message); return errs }
  if (c.schemaVersion !== 1) errs.push('schemaVersion must be 1')
  if (c.slug !== slug) errs.push(`slug "${c.slug}" must equal the folder name "${slug}"`)
  if (!isStr(c.provider)) errs.push('provider must be a non-empty string')
  if (!(c.providerUrl === null || /^https?:\/\//.test(c.providerUrl ?? ''))) errs.push('providerUrl must be an http(s) URL or null')
  if (c.logo !== null && c.logo !== undefined) {
    if (!isStr(c.logo)) errs.push('logo must be a file name, a URL, or null (omit the key if there is no logo)')
    else if (!/^https?:\/\//.test(c.logo) && !fs.existsSync(path.join(dir, c.logo))) errs.push(`logo file "${c.logo}" does not exist in the folder`)
  }
  if (c.demo !== null && c.demo !== undefined) {
    if (typeof c.demo !== 'object' || !isStr(c.demo.title) || !isStr(c.demo.language) || typeof c.demo.code !== 'string') errs.push('demo must be null or { title, language, code } strings')
  }
  if (!Array.isArray(c.setup) || !c.setup.every(isStr)) errs.push('setup must be a list of non-empty strings')
  const i = c.install
  if (!i || typeof i !== 'object') errs.push('install must be an object')
  else if (i.type === 'bankr') {
    if (i.repoPath !== slug) errs.push(`install.repoPath must equal the slug "${slug}"`)
    if (!isStr(i.command)) errs.push('install.command must be a non-empty string')
    else if (!i.command.includes(`/tree/main/${slug}`)) errs.push(`install.command should point at .../tree/main/${slug}`)
  } else if (i.type === 'external') {
    if (!isStr(i.provider) || !isStr(i.command) || !(i.reference === null || isStr(i.reference))) errs.push('external install needs provider, command and reference (string or null)')
  } else errs.push('install.type must be "bankr" or "external"')
  return errs
}

if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || '.')).href) {
  const dirs = process.argv.slice(2)
  if (!dirs.length) dirs.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  let bad = 0
  for (const d of dirs) { const e = validateSkillDir(d); if (e.length) { bad++; console.log(`FAIL ${d}\n  - ${e.join('\n  - ')}`) } else console.log(`ok   ${d}`) }
  process.exitCode = bad ? 1 : 0
}
