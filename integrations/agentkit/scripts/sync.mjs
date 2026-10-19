// Re-copies the shared logic from the MCP server package so both stay identical.
import fs from 'node:fs'
const hdr = (n) => `// @ts-nocheck\n// Generated copy of integrations/mcp/src/${n}.mjs (run npm run sync). Type checking is off for the copied file.\n`
for (const n of ['shared', 'core']) {
  let t = fs.readFileSync(new URL(`../../mcp/src/${n}.mjs`, import.meta.url), 'utf8')
  t = t.replace("from './shared.mjs'", "from './shared'")
  fs.writeFileSync(new URL(`../src/${n}.ts`, import.meta.url), hdr(n) + t)
}
console.log('synced')
