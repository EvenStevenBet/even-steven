// Viem wiring for the pinned Base-mainnet fork, plus the fork-only tricks the
// suite needs: USDC minting through Circle's real masterMinter, EIP-3009
// signing against the real token, and paired execution so a v1.10 call and the
// identical v1.11 call land in the SAME block at the SAME timestamp.
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi,
         keccak256, encodeAbiParameters, hexToBigInt, toHex } from 'viem'
import { mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// FORK_RPC lets a second fork node run in parallel on another port (the D8 fill is
// slow because every fresh storage slot costs an upstream lookup).
export const RPC_LOCAL = process.env.FORK_RPC || 'http://127.0.0.1:8545'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const OOV3 = '0x2aBf1Bd76655de80eDB3086114315Eec75AF500c'

// DO NOT use hardhat's default accounts on a MAINNET FORK. Their addresses are
// publicly known and carry real Base-mainnet state — at this pinned block every
// one of them holds an EIP-7702 delegation (code 0xef0100…). USDC's
// SignatureChecker then treats the signer as a contract and takes the EIP-1271
// path instead of ecrecover, so every valid EIP-3009 signature is rejected with
// "FiatTokenV2: invalid signature". Actors are therefore freshly generated keys,
// and assertFreshActors() below proves each one is a bare EOA on the fork.
const actorKeys = []

// pollingInterval: viem derives it from the chain (4s for Base), and every
// waitForTransactionReceipt then idles up to a full interval. Against a local
// fork that turns a few thousand transactions into hours of pure waiting.
const POLL = { pollingInterval: 20 }
export const pub  = createPublicClient({ chain: base, transport: http(RPC_LOCAL, { timeout: 180000 }), ...POLL })
export const test = createTestClient({ chain: base, mode: 'hardhat', transport: http(RPC_LOCAL, { timeout: 180000 }), ...POLL })

export function acct(i) {
  while (actorKeys.length <= i) actorKeys.push(privateKeyToAccount(generatePrivateKey()))
  return actorKeys[i]
}

/** Every actor must be a plain EOA with no code on the fork. */
export async function assertFreshActors(n) {
  const bad = []
  for (let i = 0; i < n; i++) {
    const a = acct(i)
    const code = await pub.getCode({ address: a.address })
    if (code && code !== '0x') bad.push(`${a.address} has code ${code}`)
  }
  if (bad.length) throw new Error('actor accounts are not bare EOAs on the fork:\n  ' + bad.join('\n  '))
  return n
}
export function wallet(account) {
  return createWalletClient({ account, chain: base, transport: http(RPC_LOCAL, { timeout: 180000 }), ...POLL })
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function masterMinter() view returns (address)',
  'function configureMinter(address,uint256) returns (bool)',
  'function mint(address,uint256) returns (bool)',
  'function authorizationState(address,bytes32) view returns (bool)',
])

export const ooAbi = parseAbi([
  'function getMinimumBond(address) view returns (uint256)',
  'function defaultIdentifier() view returns (bytes32)',
  'function settleAssertion(bytes32)',
])

// ── fork-only utilities ────────────────────────────────────────────────

export async function setBalanceEth(address, wei) {
  await test.setBalance({ address, value: wei })
}

let minterConfigured = false
/** Mint real Circle USDC on the fork by impersonating the token's masterMinter. */
export async function mintUSDC(to, amount) {
  const master = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'masterMinter' })
  await test.impersonateAccount({ address: master })
  await setBalanceEth(master, 10n ** 20n)
  const w = createWalletClient({ account: master, chain: base, transport: http(RPC_LOCAL, { timeout: 180000 }), ...POLL })
  if (!minterConfigured) {
    const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'configureMinter',
                                      args: [master, 2n ** 128n] })
    await pub.waitForTransactionReceipt({ hash: h })
    minterConfigured = true
  }
  const h2 = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'mint', args: [to, amount] })
  await pub.waitForTransactionReceipt({ hash: h2 })
  await test.stopImpersonatingAccount({ address: master })
}

export async function increaseTime(seconds) {
  await test.increaseTime({ seconds })
  await test.mine({ blocks: 1 })
}

export async function snapshot() { return test.snapshot() }
export async function revertTo(id) { await test.revert({ id }) }

// ── EIP-3009 ───────────────────────────────────────────────────────────

/** nonce = keccak256(abi.encode(salt, greaterThan)) — the market's R6-2 binding. */
export function derivedNonce(salt, greaterThan) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [salt, greaterThan]))
}

let cachedDomain = null
/** Build the token's EIP-712 domain from the token itself and PROVE it matches
 *  the on-chain DOMAIN_SEPARATOR before any signature is produced. */
export async function usdcDomain() {
  if (cachedDomain) return cachedDomain
  const name    = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' })
  const version = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'version' })
  const onChain = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'DOMAIN_SEPARATOR' })
  const domain  = { name, version, chainId: 8453, verifyingContract: USDC }
  const computed = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
     keccak256(toHex(name)), keccak256(toHex(version)), 8453n, USDC]))
  if (computed.toLowerCase() !== onChain.toLowerCase())
    throw new Error(`EIP-712 domain mismatch: computed ${computed} vs on-chain ${onChain}`)
  cachedDomain = { domain, name, version, onChain }
  return cachedDomain
}

const RWA_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
}

/** Sign a ReceiveWithAuthorization for `market`. Returns the Authorization struct. */
export async function signAuthorization({ signer, market, value, salt, greaterThan,
                                          validAfter = 0n, validBefore, nonceOverride }) {
  const { domain } = await usdcDomain()
  const blk = await pub.getBlock()
  const vb  = validBefore ?? blk.timestamp + 3600n
  const nonce = nonceOverride ?? derivedNonce(salt, greaterThan)
  const sigHex = await signer.signTypedData({
    domain, types: RWA_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: signer.address, to: market, value, validAfter, validBefore: vb, nonce },
  })
  return {
    validAfter, validBefore: vb, nonce, salt,
    v: Number(hexToBigInt(('0x' + sigHex.slice(130, 132)))),
    r: '0x' + sigHex.slice(2, 66),
    s: '0x' + sigHex.slice(66, 130),
    _sig: sigHex,
  }
}

// ── paired execution ───────────────────────────────────────────────────

/**
 * Run the SAME logical transaction against the v1.10 and v1.11 deployments in
 * ONE block, so block.timestamp, block.number and all fork state are identical
 * for both. Without this every timestamp-bearing getter would differ for a
 * reason that has nothing to do with the contract change.
 */
export async function pairSend(buildA, buildB) {
  await pub.request({ method: 'evm_setAutomine', params: [false] })
  let hA, hB, errA = null, errB = null
  try { hA = await buildA() } catch (e) { errA = e }
  try { hB = await buildB() } catch (e) { errB = e }
  await test.mine({ blocks: 1 })
  await pub.request({ method: 'evm_setAutomine', params: [true] })
  const rA = hA ? await pub.getTransactionReceipt({ hash: hA }).catch(() => null) : null
  const rB = hB ? await pub.getTransactionReceipt({ hash: hB }).catch(() => null) : null
  return { a: { hash: hA, receipt: rA, sendError: errA }, b: { hash: hB, receipt: rB, sendError: errB } }
}

/**
 * Raw JSON-RPC eth_call. viem wraps revert data in several error shapes and can
 * lose the raw bytes entirely; a byte-identical revert-data comparison has to
 * read the bytes the node actually returned, so this bypasses viem.
 */
export async function rawCall({ from, to, data, blockTag = 'latest' }) {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call',
                 params: [{ ...(from ? { from } : {}), to, data }, blockTag] }
  const res = await fetch(RPC_LOCAL, { method: 'POST', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify(body) })
  const j = await res.json()
  if (j.error) {
    const d = j.error.data
    const raw = typeof d === 'string' ? d : (d && typeof d.data === 'string' ? d.data : null)
    return { ok: false, data: raw, message: j.error.message }
  }
  return { ok: true, data: j.result ?? '0x' }
}

/** eth_call both sides at the current state; return raw return data or raw revert data. */
export async function pairCall(reqA, reqB) {
  const one = req => rawCall({ from: req.account?.address ?? req.account, to: req.to, data: req.data })
  return { a: await one(reqA), b: await one(reqB) }
}
