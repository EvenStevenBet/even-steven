import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * viem embeds the full RPC URL — including the Alchemy API key — in transport
 * error messages. Those messages get logged verbatim on failure, so scrub them
 * here, centrally, rather than at each call site where it could be forgotten.
 */
function redact(text: string): string {
  let out = text.split(config.rpcUrl).join('[RPC_URL_REDACTED]');

  // Fallback for URLs that don't match config.rpcUrl exactly (trailing slash,
  // a different provider path shape, a second RPC added later).
  out = out.replace(
    /https?:\/\/[^\s"']*\/v[0-9]+\/[A-Za-z0-9_-]{8,}/g,
    '[RPC_URL_REDACTED]'
  );

  // Bare API-key-looking query params.
  out = out.replace(/([?&](?:apikey|api_key|key|token)=)[^&\s"']+/gi, '$1[REDACTED]');

  return out;
}

function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(config.logDir, `deploy-${date}.jsonl`);
}

/**
 * One JSON line per event, to console and to logs/deploy-YYYY-MM-DD.jsonl.
 * Flat and grep-able — this is the audit trail of what the bot did.
 */
export function log(event: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), ...event };
  const line = redact(JSON.stringify(entry));

  console.log(line);

  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.appendFileSync(todayLogPath(), line + '\n');
  } catch (err) {
    // Never let a logging failure take down a run that's otherwise fine.
    console.error('WARNING: could not write to log file:', (err as Error).message);
  }
}
