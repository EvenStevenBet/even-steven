// Bankr signing probe. READ-ONLY + OFFLINE SIGNATURE. Moves no funds.
//
//   BANKR_API_KEY=bk_... node probe.mjs
//
// It calls only GET /wallet/me and
// POST /wallet/sign. It never calls /wallet/submit, /wallet/transfer, /wallet/swap
// or any other write, and it never calls Even Steven's POST /api/bet. The typed data
// it asks Bankr to sign has validBefore = 1 (1970), so USDC will reject the
// signature as expired if anyone ever tried to redeem it. The API key is read from
// the environment, sent only as the X-API-Key header, and is never printed,
// logged or written to disk.
import { createPublicClient, http, keccak256, encodeAbiParameters, hashTypedData, recoverAddress,
         parseAbi, getAddress, isAddress, toHex, size, hexToBytes } from 'viem'
import { base } from 'viem/chains'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const BANKR_API = 'https://api.bankr.bot'
export const FACTORY = '0x5906370b9831728ec523b647137a1bbf0ab45390'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const STAKE = 1_000_000n           // 1 USDC
export const VALUE = 1_020_000n           // stake + 2% fee
export const VALID_BEFORE = 1n            // 1970: long expired, can never be redeemed
export const ERC1271_MAGIC = '0x1626ba7e'

export const RWA_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
}
export const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }

/** Throws unless validBefore is strictly in the past. Called when building AND right before signing. */
export function assertExpired(validBefore, nowSec = Math.floor(Date.now() / 1000)) {
  if (BigInt(validBefore) >= BigInt(nowSec))
    throw new Error(`refusing to run: validBefore ${validBefore} is not in the past (now ${nowSec})`)
}

/** nonce = keccak256(abi.encode(salt, greaterThan)) — the market's R6-2 binding (see AGENTS.md). */
export function deriveNonce(salt, greaterThan) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
}

/** Typed data in the JSON shape Bankr takes: every uint256 as a decimal string. */
export function buildTypedData({ from, to, salt, greaterThan = true, validBefore = VALID_BEFORE, nowSec }) {
  assertExpired(validBefore, nowSec)
  return {
    domain: { ...DOMAIN },
    types: RWA_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from, to, value: VALUE.toString(), validAfter: '0', validBefore: BigInt(validBefore).toString(),
      nonce: deriveNonce(salt, greaterThan),
    },
  }
}

/** The EIP-712 digest USDC verifies (what an ERC-1271 wallet's isValidSignature receives). */
export function typedDataDigest(td) {
  const m = td.message
  return hashTypedData({
    domain: td.domain, types: td.types, primaryType: td.primaryType,
    message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) },
  })
}

/** no code = EOA; 0xef0100 + 20 bytes = EIP-7702 delegation; anything else = contract wallet. */
export function classifyCode(code) {
  if (!code || code === '0x') return { kind: 'eoa' }
  if (code.toLowerCase().startsWith('0xef0100')) {
    const hex = code.slice(8)
    if (hex.length === 40) return { kind: 'eip7702', delegate: getAddress('0x' + hex) }
  }
  return { kind: 'contract' }
}

/** Mirrors the Even Steven relay: exactly 65 bytes -> placeBetFor, anything else -> placeBetForWithSignature. */
export function classifySignature(sig) {
  const bytes = size(sig)
  return { bytes, relayFunction: bytes === 65 ? 'placeBetFor' : 'placeBetForWithSignature' }
}

/** Remove the API key, if it ever appears, from text we print. Bankr error bodies are otherwise left verbatim. */
export function scrub(text, apiKey) {
  const t = String(text)
  return apiKey ? t.split(apiKey).join('[REDACTED]') : t
}

/** RPC errors from viem can embed the RPC URL (and its key). Strip URLs from anything that came from the RPC. */
export function scrubUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, '[url]')
}

async function bankr(fetchImpl, apiKey, path, init = {}) {
  const res = await fetchImpl(BANKR_API + path, {
    ...init,
    headers: { 'X-API-Key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* leave null */ }
  return { status: res.status, ok: res.ok, text, json }
}

const FACTORY_ABI = parseAbi([
  'function getOpenMarkets() view returns (address[])',
  'function getAllMarkets() view returns (address[])',
  'function gameIdByMarket(address) view returns (string)',
])

/**
 * Pick the market the (expired, never-submitted) authorization is addressed to. It only has to be
 * a market the v1.6 factory created. Order: explicit override (checked with gameIdByMarket), then
 * the first open market, then the last market ever created.
 * Returns { market, source, isOpen } or { error }.
 */
export async function selectMarket({ publicClient, override }) {
  const read = (functionName, args) => publicClient.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName, args })
  const open = (await read('getOpenMarkets')).map(getAddress)
  if (override) {
    if (!isAddress(override)) return { error: `MARKET override is not an address: ${override}` }
    const market = getAddress(override)
    const gameId = await read('gameIdByMarket', [market])
    if (!gameId) return { error: `${market} was not created by Factory v1.6 (gameIdByMarket is empty). Refusing to use it.` }
    return { market, source: `override (${gameId})`, isOpen: open.includes(market) }
  }
  if (open.length) return { market: open[0], source: `first of ${open.length} open`, isOpen: true }
  const all = await read('getAllMarkets')
  if (!all.length) return { error: 'Factory v1.6 has created no markets at all. Nothing to address the authorization to.' }
  return { market: getAddress(all[all.length - 1]), source: `last of ${all.length} created (none open)`, isOpen: false }
}
const ERC1271_ABI = parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)'])

/**
 * Runs the probe. Everything external is injectable so the unit tests need no network.
 * Returns { exitCode, result }.
 */
export async function runProbe({ apiKey, fetchImpl = fetch, publicClient, log = console.log, nowSec, marketOverride, saltBytes = () => randomBytes(32) }) {
  const out = (...a) => log(scrub(a.join(' '), apiKey))
  if (!apiKey) { out('BANKR_API_KEY is not set. Run: BANKR_API_KEY=bk_... node probe.mjs'); return { exitCode: 1 } }

  // 1. wallet address
  const me = await bankr(fetchImpl, apiKey, '/wallet/me')
  if (!me.ok) { out(`GET /wallet/me failed: HTTP ${me.status}`); out(me.text); return { exitCode: 1 } }
  const evm = (me.json?.wallets || []).find(w => w.chain === 'evm')
  if (!evm || !isAddress(evm.address)) { out('GET /wallet/me returned no EVM wallet address.'); return { exitCode: 1 } }
  const wallet = getAddress(evm.address)
  out('Base wallet address :', wallet)

  // 2. what is at that address on Base
  const code = await publicClient.getCode({ address: wallet })
  const cls = classifyCode(code)
  out('Account type        :', cls.kind === 'eoa' ? 'plain EOA (no code)'
    : cls.kind === 'eip7702' ? `EIP-7702 delegated EOA, delegate ${cls.delegate}`
    : `contract wallet (${size(code)} bytes of code)`)

  // 3. a market the v1.6 factory created (it need not be open: the authorization is expired and never submitted)
  const pick = await selectMarket({ publicClient, override: marketOverride })
  if (pick.error) { out(pick.error); return { exitCode: 1 } }
  const market = pick.market
  out('Target market       :', market, `(${pick.source}; ${pick.isOpen ? 'open' : 'NOT open'}; nothing is sent to it)`)

  // 4. typed data with an already-expired validBefore
  const salt = toHex(saltBytes())
  const typedData = buildTypedData({ from: wallet, to: market, salt, greaterThan: true, nowSec })
  assertExpired(typedData.message.validBefore, nowSec)   // belt and braces, right before the only signing call
  const digest = typedDataDigest(typedData)
  out('validBefore         :', typedData.message.validBefore, '(1970, expired: cannot be redeemed)')
  out('EIP-712 digest      :', digest)

  // 5. ask Bankr to sign it
  const sign = await bankr(fetchImpl, apiKey, '/wallet/sign', {
    method: 'POST', body: JSON.stringify({ signatureType: 'eth_signTypedData_v4', typedData }),
  })
  if (sign.status === 403) {
    out('POST /wallet/sign -> HTTP 403. Body verbatim:'); out(sign.text)
    return { exitCode: 2, result: { blocked: true, status: 403 } }
  }
  if (!sign.ok || !sign.json?.success || !sign.json?.signature) {
    out(`POST /wallet/sign failed: HTTP ${sign.status}. Body verbatim:`); out(sign.text)
    return { exitCode: 1 }
  }
  const { signature, signer } = sign.json

  // 6. what did we get back
  const sc = classifySignature(signature)
  const signerMatches = !!signer && isAddress(signer) && getAddress(signer) === wallet
  out('Signature bytes     :', String(sc.bytes))
  out('Relay function      :', sc.relayFunction)
  out('Returned signer     :', signer)
  out('signer == wallet    :', String(signerMatches))

  // 7. does it verify
  let verified = null, verifyNote = ''
  if (cls.kind === 'eoa') {
    if (sc.bytes !== 65) verifyNote = 'EOA but signature is not 65 bytes; cannot ecrecover'
    else {
      const rec = await recoverAddress({ hash: digest, signature })
      verified = rec === wallet
      verifyNote = `ecrecover -> ${rec}`
    }
  } else {
    try {
      const ret = await publicClient.readContract({ address: wallet, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })
      verified = ret.toLowerCase() === ERC1271_MAGIC
      verifyNote = `isValidSignature -> ${ret} (magic is ${ERC1271_MAGIC})`
    } catch (e) {
      verified = false
      verifyNote = 'isValidSignature call reverted or is not implemented: ' + scrubUrls(e.shortMessage || 'error')
    }
  }
  out('Verification        :', verified === null ? 'not verified' : verified ? 'VALID' : 'INVALID', '-', verifyNote)

  out('')
  out('--- paste this block back ---')
  const result = { wallet, accountType: cls.kind, delegate: cls.delegate ?? null, signatureBytes: sc.bytes,
                   relayFunction: sc.relayFunction, signer, signerMatches, verified, verifyNote }
  out(JSON.stringify(result, null, 2))
  out('--- end ---')
  return { exitCode: 0, result }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const apiKey = process.env.BANKR_API_KEY
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org') })
  const i = process.argv.indexOf('--market')
  const marketOverride = (i > 0 ? process.argv[i + 1] : undefined) || process.env.MARKET || undefined
  try {
    const { exitCode } = await runProbe({ apiKey, publicClient, marketOverride })
    process.exit(exitCode)
  } catch (e) {
    console.error('probe error:', scrubUrls(scrub(e.shortMessage || e.message, apiKey)))
    process.exit(1)
  }
}
