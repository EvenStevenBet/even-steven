// The relay wallet's public address, read from config instead of hard-coded.
//
// Source of truth: data/relay.json in even-steven-app (`current`), the same file the website uses, so a
// relay rotation edits that one data file and nothing here. Order of lookup:
//   1. RELAY_ADDRESS    explicit override (a repo variable, or a one-off run against another wallet)
//   2. RELAY_JSON_URL   the raw JSON to read (default: even-steven-app main on raw.githubusercontent.com)
// There is deliberately no hard-coded fallback: a stale address would watch the wrong wallet without
// anyone noticing, so a failed lookup throws and the caller fails loudly.
import { getAddress, isAddress } from 'viem'

export const DEFAULT_RELAY_JSON_URL = 'https://raw.githubusercontent.com/EvenStevenBet/even-steven-app/main/data/relay.json'

/** Pure. The `current` address from the text of data/relay.json, checksummed. Throws if it is not one. */
export function parseRelayJson(text) {
  let cfg
  try { cfg = JSON.parse(text) } catch { throw new Error('relay config is not valid JSON') }
  if (!cfg || typeof cfg !== 'object' || typeof cfg.current !== 'string' || !isAddress(cfg.current, { strict: false })) {
    throw new Error('relay config has no valid "current" address')
  }
  return getAddress(cfg.current)
}

/** The live relay address. env is process.env; fetchFn is injectable for tests. */
export async function resolveRelayAddress(env = process.env, fetchFn = fetch) {
  const override = (env.RELAY_ADDRESS || '').trim()
  if (override) {
    if (!isAddress(override, { strict: false })) throw new Error('RELAY_ADDRESS is not a valid address')
    return getAddress(override)
  }
  const url = (env.RELAY_JSON_URL || DEFAULT_RELAY_JSON_URL).trim()
  let res
  try { res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) }) } catch (err) {
    throw new Error(`could not read the relay address from ${url}: ${err.message}`)
  }
  if (!res.ok) throw new Error(`could not read the relay address from ${url}: HTTP ${res.status}`)
  return parseRelayJson(await res.text())
}
