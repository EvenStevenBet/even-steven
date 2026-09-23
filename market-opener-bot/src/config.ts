// Must be the FIRST import: it populates process.env before anything below reads it.
// Resolves $EVEN_STEVEN_BOT_ENV, then ~/.even-steven/bot.env, then <root>/.env —
// so the private key can live outside this iCloud-synced folder. See src/env.ts.
import { ENV_FILES, envSearchList } from './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

// Resolve paths against the project root, not the current working directory.
// Without this, a cron entry that forgets to `cd` first would silently read
// and write files in the wrong place.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required env var: ${name} (see .env.example)\n` +
      (ENV_FILES.length
        ? `  loaded env files (highest precedence first):\n    ${ENV_FILES.join('\n    ')}`
        : `  NO env file was found. Looked in:\n    ${envSearchList()}`)
    );
  }
  return v.trim();
}

function requiredAddress(name: string): Address {
  const v = required(name);
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
    throw new Error(`Env var ${name} is not a valid Ethereum address: "${v}"`);
  }
  return v as Address;
}

/**
 * Strict integer parsing. Number("abc") is NaN, and NaN fails every
 * comparison silently — a typo in .env must stop the bot, never uncap it.
 */
function requiredInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Env var ${name} must be a whole number, got "${raw}". ` +
        `Refusing to run rather than guess a value for a safety limit.`
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Env var ${name} must be an integer between ${min} and ${max}, got ${n}.`);
  }
  return n;
}

/** Only the exact string "true" enables something. Anything else is false. */
function boolFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Env var ${name} must be exactly "true" or "false", got "${raw}".`);
  }
  return raw === 'true';
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

export const config = {
  // ── Chain ────────────────────────────────────────────────────────────
  rpcUrl: required('RPC_URL'),
  privateKey: required('PRIVATE_KEY') as `0x${string}`,

  // The bot refuses to run unless PRIVATE_KEY resolves to this address.
  // Whoever calls createMarket() becomes that market's owner and fee
  // recipient — a wrong key misroutes protocol fees permanently.
  productionWallet: requiredAddress('PRODUCTION_WALLET'),

  factoryAddress: requiredAddress('FACTORY_ADDRESS'),
  usdcAddress: requiredAddress('USDC_ADDRESS'),

  // ── GitHub CSV ───────────────────────────────────────────────────────
  githubToken: required('GITHUB_TOKEN'),
  githubRepoOwner: required('GITHUB_REPO_OWNER'),
  githubRepoName: required('GITHUB_REPO_NAME'),
  githubCsvPath: required('GITHUB_CSV_PATH'),

  // ── CONTROL 1: kill switch ───────────────────────────────────────────
  // false = read the sheet, log intentions, deploy nothing.
  botEnabled: boolFlag('BOT_ENABLED', false),

  // ── CONTROL 2: dry run ───────────────────────────────────────────────
  // true = full read-only rehearsal. No chain writes, no sheet writes.
  dryRun: boolFlag('DRY_RUN', true),

  // ── CONTROL 3: concurrent open markets cap ───────────────────────────
  // Counted live from the factory, so it can't be reset by deleting a file.
  // Raise this single number when you want more markets running at once.
  maxOpenMarkets: requiredInt('MAX_OPEN_MARKETS', 3, 1, 500),

  // ── CONTROL 4: per-row approval ──────────────────────────────────────
  // Column K must contain exactly this value (case-insensitive) or the
  // row is never deployed, regardless of dates or status.
  approvalToken: (process.env.APPROVAL_TOKEN?.trim() || 'yes').toLowerCase(),

  // ── Timeouts ─────────────────────────────────────────────────────────
  receiptTimeoutMs: requiredInt('RECEIPT_TIMEOUT_MS', 180_000, 30_000, 900_000),

  // ── Logging ──────────────────────────────────────────────────────────
  logDir: resolveFromRoot(process.env.LOG_DIR?.trim() || './logs'),
};
