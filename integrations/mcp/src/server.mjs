// The MCP server: six tools over the core. Stateless streamable HTTP, so it can be mounted anywhere that speaks
// Request and Response (a Next.js route, a Worker, or src/serve.mjs for local runs). It holds no keys and signs nothing.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { createCore, UserError } from './core.mjs'

export const SERVER_INFO = { name: 'even-steven', version: '0.1.0' }

const addr = z.string().describe('A 0x wallet address')
const game = z.string().describe('A gameId, a market address, or team names such as "49ers Commanders"')

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })
const wrap = (fn) => async (args) => {
  try {
    const r = await fn(args)
    if (r && r.error) return fail(r.error)
    return ok(r)
  } catch (e) {
    if (e instanceof UserError) return fail(e.message)
    return fail('Error: ' + String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '[url]'))
  }
}

export function createMcpServer(core) {
  const s = new McpServer(SERVER_INFO)
  s.registerTool('list_markets', {
    title: 'List markets',
    description: 'Open Even Steven games on Base: teams, the line, the pools and whether betting is open. Free chain read. Pass all=true to include recent closed games.',
    inputSchema: { all: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap((a) => core.listMarkets(a)))
  s.registerTool('get_quote', {
    title: 'Get a quote',
    description: 'The line and the contract\'s own gross payout quote for both sides at a stake (default 10 USDC). Free chain read, never a paid call. Quotes are not a promise: the payout is set at settlement from the final pool.',
    inputSchema: { game, stake: z.string().optional().describe('USDC amount, 1 to 25'), all: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap((a) => core.getQuote(a)))
  s.registerTool('prepare_bet', {
    title: 'Prepare a bet',
    description: 'Step 1 of 2. Resolves the game and side and returns the confirmation text, the EIP-712 typed data (a USDC ReceiveWithAuthorization) and a relay payload. Nothing is signed or sent. Show confirmationText to the user and get their confirmation, then have THEIR wallet sign typedData and call submit_bet. If the game or side is ambiguous it returns a question: ask the user, never guess. Stake is 1 to 25 USDC.',
    inputSchema: { game, side: z.string().describe('home, away, or a team name of that game'), stake: z.string().describe('USDC amount, 1 to 25'), bettor: addr.describe('The wallet that will sign and own the bet') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap((a) => core.prepareBet(a)))
  s.registerTool('submit_bet', {
    title: 'Submit a signed bet',
    description: 'Step 2 of 2. Takes the relayPayload from prepare_bet plus the wallet\'s signature. The server re-derives every field, checks the market, fee, stake, expiry, nonce and that the signature recovers to the bettor, and only then sends it to the relay, which pays the gas. USDC moves from the bettor straight to the market. Never call this without the user\'s confirmation of that prepared bet. If it fails with class "retry", resend the identical payload; with class "status", call get_status and never sign again.',
    inputSchema: { marketAddress: addr, bettor: addr, greaterThan: z.boolean().describe('true backs HOME, false backs AWAY'), stake: z.string(), validAfter: z.string(), validBefore: z.string(), nonce: z.string(), salt: z.string(), signature: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap((a) => core.submitBet(a)))
  s.registerTool('get_status', {
    title: 'Get bet status',
    description: 'A wallet\'s bets on a game with each locked line and whether it is claimed. Free chain read.',
    inputSchema: { game, bettor: addr }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap((a) => core.getStatus(a)))
  s.registerTool('claim', {
    title: 'Claim a payout',
    description: 'Collects what a wallet is owed on a settled game through the relay. Nothing is signed; the USDC is always paid to the bettor recorded on the bet. Claiming is gasless through POST /api/claim or the claim button, and depends on the relay being up. If the relay is down, claim directly with a little ETH.',
    inputSchema: { game, bettor: addr }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap((a) => core.claim(a)))
  return s
}

/** Handle one HTTP request (stateless: a fresh server and transport per request). */
export async function handle(request, deps) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  const base = deps.fetchImpl ?? fetch
  // The relay rate-limits and strikes per IP, so the end user's address is passed along (the relay must trust this host).
  const fetchImpl = ip ? (url, init = {}) => base(url, { ...init, headers: { ...(init.headers || {}), 'x-forwarded-for': ip } }) : base
  const server = createMcpServer(createCore({ ...deps, fetchImpl }))
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) } finally { await server.close().catch(() => {}) }
}
