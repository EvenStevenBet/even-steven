#!/usr/bin/env node
// Rebuilds the bundle (without the attribution setting) and copies the three reference docs from the Bankr skill.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle, OUT } from './build-openclaw.mjs'
const here = path.dirname(fileURLToPath(import.meta.url)), src = path.resolve(here, '../../../bankr/even-steven')
fs.writeFileSync(OUT, await bundle(), { mode: 0o755 })
for (const f of ['relay-errors.md', 'checks.md', 'runtime.md']) {
  let t = fs.readFileSync(path.join(src, 'references', f), 'utf8')
  fs.writeFileSync(path.resolve(here, '../references', f), t)
}
console.log('built and synced from', path.relative(process.cwd(), src))
