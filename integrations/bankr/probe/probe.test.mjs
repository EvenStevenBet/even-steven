// Unit tests: throwaway local key, mocked Bankr API, mocked RPC. No network, no real key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, encodeAbiParameters } from 'viem'
import { assertExpired, buildTypedData, deriveNonce, classifyCode, classifySignature, typedDataDigest,
         runProbe, VALID_BEFORE, ERC1271_MAGIC } from './probe.mjs'

const FAKE_KEY = 'bk_TEST_ONLY_not_a_real_key_0123456789'
const MARKET = '0xF0F11bbce394Cf780a20f8A7F63490F50a175A26'
const NOW = 1_800_000_000
const SALT = '0x' + '11'.repeat(32)
const acct = privateKeyToAccount(generatePrivateKey())

test('validBefore guard: hard-coded value is in the past', () => {
  assert.equal(VALID_BEFORE, 1n)
  assert.doesNotThrow(() => assertExpired(VALID_BEFORE, NOW))
})

test('validBefore guard: throws if changed to the future (or to now)', () => {
  assert.throws(() => assertExpired(BigInt(NOW + 600), NOW), /not in the past/)
  assert.throws(() => assertExpired(BigInt(NOW), NOW), /not in the past/)
  assert.throws(() => buildTypedData({ from: acct.address, to: MARKET, salt: SALT, validBefore: BigInt(NOW + 600), nowSec: NOW }), /not in the past/)
  assert.doesNotThrow(() => buildTypedData({ from: acct.address, to: MARKET, salt: SALT, nowSec: NOW }))
})

test('nonce = keccak256(abi.encode(salt, greaterThan)), as in AGENTS.md', () => {
  const expected = (g) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bool' }], [SALT, g]))
  assert.equal(deriveNonce(SALT, true), expected(true))
  assert.equal(deriveNonce(SALT, false), expected(false))
  assert.notEqual(deriveNonce(SALT, true), deriveNonce(SALT, false))
  const td = buildTypedData({ from: acct.address, to: MARKET, salt: SALT, greaterThan: true, nowSec: NOW })
  assert.equal(td.message.nonce, expected(true))
  assert.equal(td.message.value, '1020000')
  assert.equal(td.message.validAfter, '0')
  assert.deepEqual(td.domain, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
})

test('signature length picks the relay function', () => {
  assert.deepEqual(classifySignature('0x' + 'ab'.repeat(65)), { bytes: 65, relayFunction: 'placeBetFor' })
  assert.equal(classifySignature('0x' + 'ab'.repeat(64)).relayFunction, 'placeBetForWithSignature')
  assert.equal(classifySignature('0x' + 'ab'.repeat(66)).relayFunction, 'placeBetForWithSignature')
  assert.equal(classifySignature('0x' + 'ab'.repeat(130)).relayFunction, 'placeBetForWithSignature')
})

test('code classification: EOA vs EIP-7702 vs contract', () => {
  assert.deepEqual(classifyCode('0x'), { kind: 'eoa' })
  assert.deepEqual(classifyCode(undefined), { kind: 'eoa' })
  const delegate = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
  const r = classifyCode('0xef0100' + delegate.slice(2).toLowerCase())
  assert.equal(r.kind, 'eip7702'); assert.equal(r.delegate, delegate)
  assert.equal(classifyCode('0x6080604052').kind, 'contract')
  // 0xef0100 prefix but wrong length is not a valid delegation designator
  assert.equal(classifyCode('0xef0100abcd').kind, 'contract')
})

// ---- end-to-end against mocks -------------------------------------------------
function mocks({ code = '0x', signFn, signStatus = 200, signBody }) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ method: init.method || 'GET', path, key: init.headers?.['X-API-Key'] })
    const reply = (status, body) => ({ status, ok: status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
    if (path === '/wallet/me') return reply(200, { success: true, wallets: [{ chain: 'solana', address: 'Sol111' }, { chain: 'evm', address: acct.address }] })
    if (path === '/wallet/sign') {
      if (signStatus !== 200) return reply(signStatus, signBody)
      const td = JSON.parse(init.body).typedData
      return reply(200, { success: true, signature: await signFn(td), signer: acct.address, signatureType: 'eth_signTypedData_v4' })
    }
    return reply(404, {})
  }
  const publicClient = {
    getCode: async () => code,
    readContract: async ({ functionName }) => functionName === 'getOpenMarkets' ? [MARKET] : ERC1271_MAGIC,
  }
  return { calls, fetchImpl, publicClient }
}
const run = async (m) => {
  const lines = []
  const r = await runProbe({ apiKey: FAKE_KEY, fetchImpl: m.fetchImpl, publicClient: m.publicClient, log: l => lines.push(l), nowSec: NOW, saltBytes: () => Buffer.alloc(32, 7) })
  return { ...r, text: lines.join('\n'), lines }
}
const signWithAcct = async (td) => acct.signTypedData({
  domain: td.domain, types: td.types, primaryType: td.primaryType,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } })

test('EOA path: 65-byte signature recovers to the wallet; only /wallet/me and /wallet/sign are called', async () => {
  const m = mocks({ signFn: signWithAcct })
  const r = await run(m)
  assert.equal(r.exitCode, 0)
  assert.equal(r.result.accountType, 'eoa')
  assert.equal(r.result.signatureBytes, 65)
  assert.equal(r.result.relayFunction, 'placeBetFor')
  assert.equal(r.result.signerMatches, true)
  assert.equal(r.result.verified, true)
  assert.deepEqual(m.calls.map(c => `${c.method} ${c.path}`), ['GET /wallet/me', 'POST /wallet/sign'])
})

test('the signed typed data is expired, addressed to the market, and the key never reaches output', async () => {
  let seen
  const m = mocks({ signFn: async td => { seen = td; return signWithAcct(td) } })
  const r = await run(m)
  assert.equal(seen.message.validBefore, '1')
  assert.equal(seen.message.to, MARKET)
  assert.equal(seen.message.from, acct.address)
  assert.ok(!r.text.includes(FAKE_KEY))
  assert.ok(m.calls.every(c => c.key === FAKE_KEY))   // key goes out only as the header
})

test('non-65-byte signature (wrapped, ERC-1271 wallet) -> placeBetForWithSignature, verified via isValidSignature', async () => {
  const m = mocks({ code: '0x6080604052', signFn: async td => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, await signWithAcct(td)]) })
  const r = await run(m)
  assert.equal(r.exitCode, 0)
  assert.equal(r.result.accountType, 'contract')
  assert.equal(r.result.relayFunction, 'placeBetForWithSignature')
  assert.equal(r.result.verified, true)
})

test('EIP-7702 account whose delegate rejects: reported INVALID, not crashed', async () => {
  const m = mocks({ code: '0xef0100' + '63c0c19a282a1B52b07dD5a65b58948A07DAE32B'.toLowerCase(), signFn: signWithAcct })
  m.publicClient.readContract = async ({ functionName }) => { if (functionName === 'getOpenMarkets') return [MARKET]; throw Object.assign(new Error('x'), { shortMessage: 'reverted at https://rpc.example/KEY123' }) }
  const r = await run(m)
  assert.equal(r.result.accountType, 'eip7702')
  assert.equal(r.result.verified, false)
  assert.ok(!r.text.includes('KEY123'))
})

test('403 on /wallet/sign: body printed verbatim, run stops with exit 2', async () => {
  const body = '{"error":"Restricted API key","message":"Use https://bankr.bot/api-keys"}'
  const m = mocks({ signStatus: 403, signBody: body })
  const r = await run(m)
  assert.equal(r.exitCode, 2)
  assert.ok(r.lines.includes(body))
  assert.equal(r.result.blocked, true)
})

test('a key echoed back in an error body is redacted', async () => {
  const m = mocks({ signStatus: 400, signBody: `bad key ${FAKE_KEY}` })
  const r = await run(m)
  assert.ok(!r.text.includes(FAKE_KEY))
})

test('missing key: refuses, calls nothing', async () => {
  const m = mocks({ signFn: signWithAcct })
  const lines = []
  const r = await runProbe({ apiKey: undefined, fetchImpl: m.fetchImpl, publicClient: m.publicClient, log: l => lines.push(l) })
  assert.equal(r.exitCode, 1); assert.equal(m.calls.length, 0)
})

test('digest helper matches viem signature recovery', async () => {
  const td = buildTypedData({ from: acct.address, to: MARKET, salt: SALT, nowSec: NOW })
  const { recoverAddress } = await import('viem')
  assert.equal(await recoverAddress({ hash: typedDataDigest(td), signature: await signWithAcct(td) }), acct.address)
})
