// node --test scripts/relay-address.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RELAY_JSON_URL, parseRelayJson, resolveRelayAddress } from './relay-address.mjs'

const OLD = '0x8a3eee4f6aD1c03Dc3d898ecD61283560Bd42fed'
const NEW = '0x4444444444444444444444444444444444444444'
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body })

test('parseRelayJson returns the checksummed current address and ignores previous and next', () => {
  assert.equal(parseRelayJson(JSON.stringify({ current: OLD.toLowerCase(), previous: [NEW], next: NEW })), OLD)
})

test('parseRelayJson rejects anything without a valid current address', () => {
  for (const bad of ['not json', '{}', '[]', 'null', '{"current":"0x123"}', '{"current":5}', '{"current":null}']) {
    assert.throws(() => parseRelayJson(bad), /relay config/, bad)
  }
})

test('no override: reads current from the default URL', async () => {
  let asked
  const addr = await resolveRelayAddress({}, async (url) => { asked = url; return ok(JSON.stringify({ current: NEW, previous: [OLD], next: null }))() })
  assert.equal(addr, NEW)
  assert.equal(asked, DEFAULT_RELAY_JSON_URL)
  assert.match(DEFAULT_RELAY_JSON_URL, /even-steven-app\/main\/data\/relay\.json$/)
})

test('RELAY_JSON_URL changes where it reads from', async () => {
  let asked
  await resolveRelayAddress({ RELAY_JSON_URL: 'https://example.test/r.json' }, async (u) => { asked = u; return ok(JSON.stringify({ current: NEW }))() })
  assert.equal(asked, 'https://example.test/r.json')
})

test('RELAY_ADDRESS wins and nothing is fetched', async () => {
  const addr = await resolveRelayAddress({ RELAY_ADDRESS: NEW }, async () => { throw new Error('must not fetch') })
  assert.equal(addr, NEW)
})

test('an invalid RELAY_ADDRESS is an error, not a silent fall-through to the file', async () => {
  await assert.rejects(resolveRelayAddress({ RELAY_ADDRESS: 'oops' }, ok('{}')), /RELAY_ADDRESS is not a valid address/)
})

test('a failed lookup throws; there is no hard-coded fallback address', async () => {
  await assert.rejects(resolveRelayAddress({}, async () => { throw new Error('offline') }), /could not read the relay address/)
  await assert.rejects(resolveRelayAddress({}, async () => ({ ok: false, status: 404, text: async () => '' })), /HTTP 404/)
  await assert.rejects(resolveRelayAddress({}, ok('{"current":"nope"}')), /relay config/)
})
