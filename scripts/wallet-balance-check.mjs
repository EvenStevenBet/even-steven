// Read-only ETH balance check for the relay and the owner wallet. Run hourly by
// .github/workflows/wallet-balance.yml; exits 1 (failing the job, which emails
// the repo owner) when either wallet is below its threshold. Sends nothing and
// needs no key. Never prints the RPC URL.
//
// Env: BASE_RPC_URL (required), RELAY_MIN_BALANCE_ETH, OWNER_MIN_BALANCE_ETH, and optionally RELAY_ADDRESS /
// RELAY_JSON_URL (default: data/relay.json in even-steven-app main; there is no hard-coded fallback).
//
// Default thresholds, from each wallet's recent transactions (2026-10-15):
//   relay  0.0021 ETH — the app stops relaying below RELAY_MIN_ETH (0.002), so
//          this leaves ~50 of its most expensive recent txs (max 0.0000017 ETH
//          each, gas + L1 fee) of runway above that floor.
//   owner  0.0003 ETH — ~50 x the average of its last 20 txs (0.0000057 ETH).
import { createPublicClient, formatEther, http, parseEther } from 'viem'
import { base } from 'viem/chains'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRelayAddress } from './relay-address.mjs'

// The relay address comes from config (see relay-address.mjs), so a relay rotation never edits this file.
export const walletsFor = (relayAddress) => [
  { name: 'relay', address: relayAddress, env: 'RELAY_MIN_BALANCE_ETH', fallback: '0.0021' },
  { name: 'owner', address: '0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916', env: 'OWNER_MIN_BALANCE_ETH', fallback: '0.0003' },
]

/** Pure: which wallets are under their threshold. */
export function belowThreshold(rows) {
  return rows.filter((r) => r.balance < r.threshold)
}

async function main() {
  const url = process.env.BASE_RPC_URL
  if (!url) { console.log('::error::BASE_RPC_URL is not set'); process.exit(1) }
  const client = createPublicClient({ chain: base, transport: http(url, { timeout: 10_000, retryCount: 2 }) })

  let relayAddress
  try { relayAddress = await resolveRelayAddress() } catch (err) { console.log(`::error::${err.message}`); process.exit(1) }
  const rows = []
  for (const w of walletsFor(relayAddress)) {
    const threshold = parseEther((process.env[w.env] || w.fallback).trim())
    let balance
    try {
      balance = await client.getBalance({ address: w.address })
    } catch (err) {
      // viem errors carry the RPC URL; print only the short message.
      console.log(`::error::could not read the ${w.name} balance: ${err?.shortMessage ?? err?.name ?? 'RPC error'}`)
      process.exit(1)
    }
    rows.push({ ...w, balance, threshold })
    console.log(`${w.name.padEnd(5)} ${w.address}  ${formatEther(balance)} ETH  (threshold ${formatEther(threshold)} ETH)`)
  }

  const low = belowThreshold(rows)
  for (const r of low) {
    console.log(`::error title=${r.name} wallet low on ETH::${r.name} ${r.address} holds ${formatEther(r.balance)} ETH, below ${formatEther(r.threshold)} ETH — top it up`)
  }
  if (low.length) process.exit(1)
  console.log('all wallets above threshold')
}

// Run only when executed directly (not when the test imports belowThreshold).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
