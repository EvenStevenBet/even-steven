#!/usr/bin/env node
// Local run only: POST http://127.0.0.1:8787/mcp. This is not a deployment. Read-only chain access plus the relay
// at https://evensteven.bet. The server holds no keys.
import http from 'node:http'
import { createPublicClient, http as viemHttp } from 'viem'
import { base } from 'viem/chains'
import { handle } from './server.mjs'

const publicClient = createPublicClient({ chain: base, transport: viemHttp(process.env.BASE_RPC_URL || 'https://mainnet.base.org') })
http.createServer(async (req, res) => {
  if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return }
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }),
    { publicClient, maxStake: process.env.ES_MAX_STAKE || 25 })
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()))
}).listen(8787, '127.0.0.1', () => console.log('even-steven MCP on http://127.0.0.1:8787/mcp'))
