import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const here = (f) => new URL(f, import.meta.url)
const sj = JSON.parse(fs.readFileSync(here('../server.json'), 'utf8'))
test('server.json validates against the MCP Registry schema (2025-12-11)', () => {
  const schema = JSON.parse(fs.readFileSync(here('./server.schema.json'), 'utf8'))
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv)
  const validate = ajv.compile(schema)
  assert.ok(validate(sj), JSON.stringify(validate.errors))
})
test('listing: namespace, remote, and a description under the 100-character cap and the copy rules', () => {
  assert.equal(sj.name, 'io.github.EvenStevenBet/even-steven')
  assert.deepEqual(sj.remotes, [{ type: 'streamable-http', url: 'https://evensteven.bet/mcp' }])
  assert.ok(sj.description.length <= 100, String(sj.description.length))
  assert.ok(sj.description.startsWith('Back either side at even money'))        // value order: even money, early spread, flat 2%
  assert.ok(sj.description.indexOf('even money') < sj.description.indexOf('spread') && sj.description.indexOf('spread') < sj.description.indexOf('2%'))
  assert.doesNotMatch(JSON.stringify(sj), /legal|licensed|regulated|permissionless|audited|guaranteed|profit|builder|points|\$100|at liquidity|vig/i)
})
