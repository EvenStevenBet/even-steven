// The MCP protocol over plain HTTP (stateless streamable HTTP), end to end through handle().
import test from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/server.mjs'
import { wallet, MK2, SALT, NOW, world, chain, signTd, okBet } from './helpers.mjs'

function deps(over = {}) {
  const w = world(over); const fetches = []
  return { fetches, publicClient: chain(w), now: () => NOW, randomSalt: () => SALT,
    fetchImpl: async (url, init = {}) => { fetches.push({ url, init }); return { status: 200, ok: true, text: async () => JSON.stringify(okBet()) } } }
}
const rpc = (d, method, params, id = 1, headers = {}) => handle(new Request('http://localhost/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }), d)
const result = async (res) => (await res.json()).result

test('initialize and tools/list expose exactly the six tools, none of which can sign', async () => {
  const d = deps()
  const init = await result(await rpc(d, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
  assert.equal(init.serverInfo.name, 'even-steven')
  const list = await result(await rpc(d, 'tools/list', {}))
  assert.deepEqual(list.tools.map((t) => t.name).sort(), ['claim', 'get_quote', 'get_status', 'list_markets', 'prepare_bet', 'submit_bet'])
  const byName = Object.fromEntries(list.tools.map((t) => [t.name, t]))
  assert.deepEqual(byName.prepare_bet.inputSchema.required.sort(), ['bettor', 'game', 'side', 'stake'])
  assert.ok(byName.prepare_bet.description.includes('Nothing is signed or sent'))
  assert.ok(byName.claim.description.includes('Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.'))
  for (const t of list.tools) assert.doesNotMatch(t.description, /private key|seed phrase|builder|points|audited|guaranteed|profit/i, t.name)
})
test('tools/call list_markets returns structured content over HTTP', async () => {
  const r = await result(await rpc(deps(), 'tools/call', { name: 'list_markets', arguments: {} }))
  assert.equal(r.isError, undefined); assert.equal(r.structuredContent.markets.length, 3)
})
test('the two-step bet over HTTP: prepare, the client signs, submit', async () => {
  const d = deps()
  const p = (await result(await rpc(d, 'tools/call', { name: 'prepare_bet', arguments: { game: 'Packers Cowboys', side: 'away', stake: '10', bettor: wallet.address } }))).structuredContent
  assert.equal(p.status, 'ready')
  const sig = await signTd(wallet, p.typedData)           // the CLIENT signs; the server never does
  const s = await result(await rpc(d, 'tools/call', { name: 'submit_bet', arguments: { ...p.relayPayload, signature: sig } }))
  assert.equal(s.structuredContent.placed, true); assert.equal(d.fetches.length, 1)
  assert.equal(JSON.parse(d.fetches[0].init.body).signature, sig)
})
test('a bad submission is an isError result, never a relay call', async () => {
  const d = deps()
  const p = (await result(await rpc(d, 'tools/call', { name: 'prepare_bet', arguments: { game: 'Packers Cowboys', side: 'away', stake: '10', bettor: wallet.address } }))).structuredContent
  const r = await result(await rpc(d, 'tools/call', { name: 'submit_bet', arguments: { ...p.relayPayload, stake: '10000001', signature: await signTd(wallet, p.typedData) } }))
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Not submitted/); assert.equal(d.fetches.length, 0)
})
test('the caller\'s IP is forwarded to the relay (it rate-limits and strikes per IP)', async () => {
  const d = deps()
  const p = (await result(await rpc(d, 'tools/call', { name: 'prepare_bet', arguments: { game: 'Packers Cowboys', side: 'away', stake: '10', bettor: wallet.address } }))).structuredContent
  await rpc(d, 'tools/call', { name: 'submit_bet', arguments: { ...p.relayPayload, signature: await signTd(wallet, p.typedData) } }, 2, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })
  assert.equal(d.fetches[0].init.headers['x-forwarded-for'], '203.0.113.9')
})
test('claim over HTTP carries the exact claiming sentence', async () => {
  const d = deps(); const r = await result(await rpc(d, 'tools/call', { name: 'claim', arguments: { game: MK2, bettor: wallet.address } }))
  assert.ok(JSON.stringify(r.structuredContent).includes('Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.'))
})
