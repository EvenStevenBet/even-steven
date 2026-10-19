#!/usr/bin/env node
// Copies the built single-file bundle (and the three reference docs) from the Bankr skill, so both skills run identical code.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url)), src = path.resolve(here, '../../../bankr/even-steven')
fs.copyFileSync(path.join(src, 'scripts/even-steven.bundle.mjs'), path.join(here, 'even-steven.bundle.mjs'))
for (const f of ['relay-errors.md', 'checks.md', 'runtime.md']) fs.copyFileSync(path.join(src, 'references', f), path.resolve(here, '../references', f))
console.log('synced from', path.relative(process.cwd(), src))
