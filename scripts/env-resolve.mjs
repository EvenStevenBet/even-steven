/**
 * Shared env-file resolution for the deploy/rehearsal scripts.
 *
 * WHY: this repo lives under ~/Desktop, which is an iCloud-synced folder. Anything
 * holding a private key or an API key must not sit there. ~/.even-steven/.env is
 * outside the synced tree; scripts/.env is kept last only so an existing checkout
 * keeps working until the file is moved.
 *
 * Resolution order (first file that exists wins):
 *   1. $EVEN_STEVEN_ENV        explicit override
 *   2. ~/.even-steven/.env     preferred home for key material
 *   3. <scripts>/.env          legacy location, inside the synced tree
 *
 * Real environment variables already set always take precedence — dotenv does not
 * override by default.
 *
 * scripts/fork-tests/hardhat.config.cjs carries a CommonJS twin of this logic
 * because a .cjs config cannot import an ES module. Keep the two in step.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'

export function envCandidates(scriptsDir) {
  return [
    process.env.EVEN_STEVEN_ENV,
    path.join(os.homedir(), '.even-steven', '.env'),
    path.resolve(scriptsDir, '.env'),
  ].filter(Boolean)
}

/** Load the first env file that exists. Returns its path, or null if none was found. */
export function loadEnv(scriptsDir) {
  for (const p of envCandidates(scriptsDir)) {
    try { if (fs.statSync(p).isFile()) { dotenv.config({ path: p }); return p } }
    catch { /* not there — try the next candidate */ }
  }
  return null
}

/** Human-readable list for error messages, so a missing key says where to put it. */
export function envSearchList(scriptsDir) {
  return envCandidates(scriptsDir).join('\n    ')
}
