/**
 * Env-file resolution for the bot.
 *
 * WHY THIS EXISTS: `import 'dotenv/config'` loads `.env` from the CURRENT WORKING
 * DIRECTORY, so a cron entry that forgets to `cd` first silently starts the bot with
 * no configuration — the same class of bug PROJECT_ROOT already guards against for
 * file paths. Worse, it forces the private key to live inside the repo folder, which
 * sits under ~/Desktop and is iCloud-synced.
 *
 * All of these are LAYERED, highest precedence first — not first-wins:
 *   1. $EVEN_STEVEN_BOT_ENV        explicit override
 *   2. ~/.even-steven/bot.env      secrets live here — NOT iCloud-synced
 *   3. <project root>/.env         non-secret config, inside the synced tree
 *
 * Layering is the point. The intended split is secrets (PRIVATE_KEY, RPC_URL,
 * GITHUB_TOKEN) in the home file and everything else — FACTORY_ADDRESS,
 * PRODUCTION_WALLET, the controls — in the repo .env where it can be reviewed in a
 * diff. First-wins would silently hide the repo file the moment the home file
 * existed, leaving FACTORY_ADDRESS unset and the bot dead with a confusing error.
 *
 * dotenv does not overwrite a variable that is already set, so loading in
 * precedence order gives exactly this: the home file wins where the two overlap,
 * the repo file fills the rest, and a real environment variable beats both.
 *
 * This mirrors scripts/env-resolve.mjs in the contracts repo. The two are kept
 * separate on purpose — this package has its own dependencies and build — so if you
 * change one, change the other.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

export const ENV_CANDIDATES: string[] = [
  process.env.EVEN_STEVEN_BOT_ENV,
  path.join(os.homedir(), '.even-steven', 'bot.env'),
  path.join(projectRoot, '.env'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

function existing(): string[] {
  return ENV_CANDIDATES.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Every env file loaded, highest precedence first. Empty if none was found. */
export const ENV_FILES: string[] = existing();
for (const p of ENV_FILES) dotenv.config({ path: p });

/** The highest-precedence file loaded, or null. Kept for error messages. */
export const ENV_FILE: string | null = ENV_FILES[0] ?? null;

/** Human-readable search list, for error messages that have to say where to look. */
export function envSearchList(): string {
  return ENV_CANDIDATES.join('\n    ');
}
