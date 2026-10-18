// node --test scripts/x-search.test.mjs
import crypto from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLUMNS, collect, nextBatch, serviceAccountJwt, sheetName, toRows, xSearch } from './x-search.mjs'

const body = ids => ({
  data: ids.map(id => ({ id, author_id: 'u' + id, text: `=SUM(${id})`, created_at: '2026-10-17T00:00:00Z', public_metrics: { like_count: 3, retweet_count: 1 } })),
  includes: { users: ids.map(id => ({ id: 'u' + id, username: 'h' + id, public_metrics: { followers_count: 42 } })) },
})

test('rows follow the column order and dedupe across queries', () => {
  const seen = new Set()
  const a = toRows('q1', body(['1', '2']), seen)
  assert.equal(a[0].length, COLUMNS.length)
  assert.deepEqual(a[0], ['q1', 'https://x.com/h1/status/1', 'h1', 42, '=SUM(1)', '2026-10-17T00:00:00Z', 3, 1])
  assert.equal(toRows('q2', body(['2', '3']), seen).length, 1)
})

test('nextBatch honours the cap and the API minimum', () => {
  assert.equal(nextBatch({ cap: 200, have: 0, perQuery: 40 }), 40)
  assert.equal(nextBatch({ cap: 200, have: 195, perQuery: 40 }), 10)
  assert.equal(nextBatch({ cap: 200, have: 200, perQuery: 40 }), 0)
  assert.equal(nextBatch({ cap: 500, have: 0, perQuery: 300 }), 100)
})

test('collect stops at the cap even if X returns more', async () => {
  let calls = 0
  const search = async (_q, n) => { calls++; return body(Array.from({ length: n }, (_, i) => `${calls}-${i}`)) }
  const { rows, error } = await collect({ queries: ['a', 'b', 'c', 'd', 'e'], maxPostsPerRun: 25, suffix: '' }, search)
  assert.equal(rows.length, 25)
  assert.equal(error, null)
  assert.ok(calls <= 3)
})

test('collect keeps rows gathered before an X error and reports it', async () => {
  let n = 0
  const search = async () => { if (n++ === 1) throw new Error('X search answered 429'); return body(['1', '2']) }
  const { rows, error } = await collect({ queries: ['a', 'b', 'c'], maxPostsPerRun: 200, suffix: '' }, search)
  assert.equal(rows.length, 2)
  assert.match(error.message, /429/)
})

test('xSearch sends the bearer token only as a header', async () => {
  let seen
  await xSearch('TOKEN123', async (url, init) => { seen = { url: String(url), init }; return { ok: true, json: async () => ({}) } })('"nfl picks" -is:retweet', 20)
  assert.ok(!seen.url.includes('TOKEN123'))
  assert.equal(seen.init.headers.Authorization, 'Bearer TOKEN123')
  assert.match(seen.url, /max_results=20/)
})

test('service account JWT verifies against its public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwt = serviceAccountJwt({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 1000)
  const [h, c, s] = jwt.split('.')
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')))
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).scope, 'https://www.googleapis.com/auth/drive')
})

test('sheet name', () => assert.equal(sheetName('2026-10-18'), 'ES - X Search 2026-10-18'))
