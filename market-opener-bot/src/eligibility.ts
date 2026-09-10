import { config } from './config.js';
import type { SheetRow } from './csv.js';

/**
 * Strict ISO-8601 with explicit timezone. Deliberately narrow: new Date()
 * accepts things like "11/08/2026" and silently reads it as November 8,
 * and accepts "2026-08-11 12:00:00" as *server local time* — a several-hour
 * shift depending on the machine's timezone. Both would open markets at the
 * wrong time, silently. Anything not matching this is rejected loudly.
 */
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseStrictDate(value: string): Date | null {
  if (!ISO_STRICT.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type Decision =
  | { deploy: true }
  | { deploy: false; reason: string; notable: boolean };

const KNOWN_STATUSES = new Set([
  'coming_soon',
  'open',
  'closed',
  'settled',
  'cancelled',
  'canceled',
  'expired',
  'refund',
]);

/**
 * Every gate a row must pass. Order matters only for log clarity.
 * `notable` marks reasons worth surfacing (something you may want to fix)
 * versus the ordinary "not this row, not today" cases.
 */
export function evaluate(row: SheetRow, now: Date): Decision {
  if (row.marketAddress !== '') {
    return { deploy: false, reason: 'market_already_recorded', notable: false };
  }

  if (row.status !== 'coming_soon') {
    // A value that only differs by casing is almost certainly a typo, and
    // would otherwise make a game silently never open. Flag it loudly.
    if (row.status.toLowerCase() === 'coming_soon') {
      return { deploy: false, reason: `status_casing_typo:${row.status}`, notable: true };
    }
    // Anything outside the known lifecycle values is also worth surfacing.
    const notable = !KNOWN_STATUSES.has(row.status.toLowerCase());
    return {
      deploy: false,
      reason: notable ? `unrecognised_status:${row.status}` : 'status_not_coming_soon',
      notable,
    };
  }

  // ── CONTROL 4: per-row approval ──────────────────────────────────────
  // Nothing deploys without you having typed the approval token in column K.
  if (row.approved.toLowerCase() !== config.approvalToken) {
    if (row.approved !== '') {
      return { deploy: false, reason: `approval_not_recognised:${row.approved}`, notable: true };
    }
    return { deploy: false, reason: 'not_approved', notable: false };
  }

  const opensAt = parseStrictDate(row.bettingOpensAt);
  if (!opensAt) {
    return {
      deploy: false,
      reason: `invalid_bettingOpensAt:${row.bettingOpensAt}`,
      notable: true,
    };
  }

  const gameDate = parseStrictDate(row.gameDate);
  if (!gameDate) {
    return { deploy: false, reason: `invalid_gameDate:${row.gameDate}`, notable: true };
  }

  // Never open betting on a game that has already kicked off. This is a code
  // guard, not a data-hygiene assumption — an approved-but-stale row must not
  // be able to create a market on a finished game.
  if (gameDate <= now) {
    return { deploy: false, reason: 'game_already_started', notable: true };
  }

  if (now < opensAt) {
    return { deploy: false, reason: 'betting_window_not_open_yet', notable: false };
  }

  return { deploy: true };
}
