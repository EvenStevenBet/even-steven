// Core of scripts/market-ops.mjs, kept free of process/network globals so every check can be
// tested with mocks. Nothing here spawns a child process, touches argv for secrets, or writes the
// signing key to process.env. The key is read ONLY by loadSigner(), inside this process, and only
// on a --confirm run.
import { createPublicClient, createWalletClient, fallback, http, parseAbi, parseUnits, formatUnits,
         formatEther, getAddress, isAddress, maxUint256, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

export const FACTORY = getAddress('0x5906370b9831728ec523b647137a1bbf0ab45390')
export const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
// Sanity anchor: the wallet that must own the factory and sign. Override only through PRODUCTION_WALLET
// in the signer's own env file (loaded inside the process), exactly like the opener bot.
export const EXPECTED_OWNER = getAddress('0x28953e3FCCfC0Ae1c4d5899c795Df41667c5B336')
export const Z_LIMIT = 5_000_000n
export const SEED_MIN = 1n, SEED_MAX = 1000n // whole-USDC bounds, inclusive

export const factoryAbi = parseAbi([
  'function owner() view returns (address)',
  'function marketByGameId(string) view returns (address)',
  'function gameIdByMarket(address) view returns (string)',
  'function getOpenMarkets() view returns (address[])',
  'function createMarket(string gameId, int256 oracleZ, uint256 protocolSeed) returns (address)',
  'event MarketCreated(address indexed market, string gameId, int256 oracleZ, int256 spreadMax, int256 spreadMin, uint256 feePercent, address indexed creator)',
])
export const marketAbi = parseAbi([
  'function owner() view returns (address)', 'function gameId() view returns (string)', 'function oo() view returns (address)',
  'function bettingOpen() view returns (bool)', 'function settled() view returns (bool)', 'function canceled() view returns (bool)',
  'function refundMode() view returns (bool)', 'function paused() view returns (bool)', 'function assertionActive() view returns (bool)',
  'function assertionId() view returns (bytes32)', 'function pendingSpread() view returns (int256)', 'function finalSpread() view returns (int256)',
  'function bettingClosedAt() view returns (uint256)', 'function canTriggerRefund() view returns (bool)',
  'function SPREAD_MAX() view returns (int256)', 'function SPREAD_MIN() view returns (int256)', 'function PROTOCOL_SEED() view returns (uint256)',
  'function initialZ() view returns (int256)', 'function currentZ() view returns (int256)',
  'function totalPool() view returns (uint256)', 'function protocolSeedTotal() view returns (uint256)',
  'function REFUND_TIMEOUT() view returns (uint256)',
  'function closeBetting()', 'function cancelMarket()', 'function triggerRefund()', 'function pause()', 'function unpause()',
  'function requestSettlement(int256 _proposedSpread)', 'function executeSettlement()',
])
export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
export const ooAbi = parseAbi([
  'struct EscalationManagerSettings { bool arbitrateViaEscalationManager; bool discardOracle; bool validateDisputers; address assertingCaller; address escalationManager; }',
  'struct Assertion { EscalationManagerSettings escalationManagerSettings; address asserter; uint64 assertionTime; bool settled; address currency; uint64 expirationTime; bool settlementResolution; bytes32 domainId; bytes32 identifier; uint256 bond; address callbackRecipient; address disputer; }',
  'function getAssertion(bytes32) view returns (Assertion)', 'function getMinimumBond(address) view returns (uint256)',
])

export class Refusal extends Error {}
const refuse = m => { throw new Refusal(m) }

/** Remove anything that could carry a secret from text about to be printed (RPC URLs, the key itself). */
export function scrub(text, secrets = []) {
  let s = String(text ?? '')
  for (const k of secrets) if (k) s = s.split(k).join('<redacted>').split(k.replace(/^0x/, '')).join('<redacted>')
  return s.replace(/https?:\/\/\S+/g, '<url>').replace(/0x[0-9a-fA-F]{64}/g, '<hex64>')
}

// ── CSV: only what the kickoff closer needs ────────────────────────────────────────────────
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
export function csvGameDate(csvText, gameId) {
  const lines = csvText.split(/\r?\n/)
  for (const line of lines.slice(1)) {
    const c = line.split(',')
    if ((c[0] ?? '').trim() === gameId) {
      const d = (c[4] ?? '').trim()
      return ISO_STRICT.test(d) && !Number.isNaN(Date.parse(d)) ? d : null
    }
  }
  return undefined // no row at all
}

// ── Arguments ──────────────────────────────────────────────────────────────────────────────
const MARKET_TARGET = ['market', 'game-id']
export const COMMANDS = {
  status: { flags: MARKET_TARGET, send: false },
  'open-market': { flags: ['game-id', 'z', 'seed'], send: true },
  'close-betting': { flags: MARKET_TARGET, send: true },
  'trigger-refund': { flags: MARKET_TARGET, send: true },
  'approve-bond': { flags: MARKET_TARGET, send: true },
  'request-settlement': { flags: [...MARKET_TARGET, 'spread'], send: true },
  'execute-settlement': { flags: MARKET_TARGET, send: true },
  'cancel-market': { flags: MARKET_TARGET, send: true },
  pause: { flags: MARKET_TARGET, send: true },
  unpause: { flags: MARKET_TARGET, send: true },
}
const ALIASES = { state: 'status', close: 'close-betting' }

export function parseArgs(argv) {
  const [raw, ...rest] = argv
  if (!raw) refuse('usage: market-ops.mjs <' + Object.keys(COMMANDS).join('|') + '> [flags] [--confirm]')
  const cmd = ALIASES[raw] || raw
  const spec = COMMANDS[cmd]
  if (!spec) refuse(`unknown command "${raw}". Commands: ${Object.keys(COMMANDS).join(', ')}`)
  const flags = {}; let confirm = false
  for (let i = 0; i < rest.length; i++) {
    let t = rest[i]
    if (!t.startsWith('--')) refuse(`unexpected argument "${t}"`)
    let name = t.slice(2), val
    if (name.includes('=')) { [name, val] = [name.slice(0, name.indexOf('=')), name.slice(name.indexOf('=') + 1)] }
    if (name === 'confirm') { if (val !== undefined) refuse('--confirm takes no value'); confirm = true; continue }
    if (!spec.flags.includes(name)) refuse(`--${name} is not a flag of ${cmd} (allowed: ${spec.flags.map(f => '--' + f).join(' ') || 'none'}, --confirm)`)
    if (val === undefined) { val = rest[i + 1]; if (val === undefined || val.startsWith('--')) refuse(`--${name} needs a value`); i++ }
    if (name in flags) refuse(`--${name} given twice`)
    flags[name] = val
  }
  // Keys never travel in argv: refuse anything shaped like one, in any position.
  for (const v of argv) if (/^(--[\w-]+=)?(0x)?[0-9a-fA-F]{64}$/.test(v)) refuse('an argument looks like a private key. Keys are never accepted on the command line.')
  if (confirm && !spec.send) refuse(`${cmd} is read-only; --confirm does not apply`)
  return { cmd, flags, confirm }
}

// ── Signer: the ONLY place the key is read, and only on --confirm ──────────────────────────
/** Reads PRIVATE_KEY / PRODUCTION_WALLET from the env file into locals. Never touches process.env. */
export function makeLoadSigner({ readFile, envPath, parseEnv }) {
  return () => {
    let parsed
    try { parsed = parseEnv(readFile(envPath)) } catch { refuse('could not load the signer env file (not found or unreadable)') }
    const k = (parsed.PRIVATE_KEY || '').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) refuse('the signer env file has no valid PRIVATE_KEY')
    const pw = (parsed.PRODUCTION_WALLET || '').trim()
    if (pw && !isAddress(pw)) refuse('PRODUCTION_WALLET in the signer env file is not an address')
    return { account: privateKeyToAccount(k), productionWallet: pw ? getAddress(pw) : null, secrets: [k] }
  }
}

export function makeClients(rpcUrls) {
  const transport = fallback(rpcUrls.map(u => http(u, { timeout: 60_000 })))
  return { pub: createPublicClient({ chain: base, transport }), makeWallet: account => createWalletClient({ account, chain: base, transport }) }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────
const f6 = v => formatUnits(v, 6)
const iso = s => (s === 0n ? '0' : new Date(Number(s) * 1000).toISOString())
const read = (pub, address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args })

async function snapshot(pub, owner, market) {
  const s = { ownerUsdc: await read(pub, USDC, erc20Abi, 'balanceOf', [owner]), ownerEth: await pub.getBalance({ address: owner }) }
  if (market) {
    s.marketUsdc = await read(pub, USDC, erc20Abi, 'balanceOf', [market])
    s.allowanceToMarket = await read(pub, USDC, erc20Abi, 'allowance', [owner, market])
  }
  return s
}
function printSnap(out, label, s) {
  out(`  ${label}: owner USDC ${f6(s.ownerUsdc)} | owner ETH ${formatEther(s.ownerEth)}` +
    (s.marketUsdc !== undefined ? ` | market USDC ${f6(s.marketUsdc)} | owner->market allowance ${s.allowanceToMarket === maxUint256 ? 'max' : s.allowanceToMarket > maxUint256 / 2n ? 'max (Circle decrements it as it is used)' : f6(s.allowanceToMarket)}` : ''))
}

async function resolveMarket(pub, flags, owner) {
  if (flags.market && flags['game-id']) refuse('give --market or --game-id, not both')
  let market
  if (flags.market) {
    if (!isAddress(flags.market)) refuse('--market is not an address')
    market = getAddress(flags.market)
  } else if (flags['game-id']) {
    market = getAddress(await read(pub, FACTORY, factoryAbi, 'marketByGameId', [flags['game-id']]))
    if (market === '0x0000000000000000000000000000000000000000') refuse(`the factory has no market for "${flags['game-id']}"`)
  } else refuse('give --market 0x… or --game-id <gameId>')
  const registered = await read(pub, FACTORY, factoryAbi, 'gameIdByMarket', [market])
  if (!registered) refuse(`${market} is not a market of Factory v1.6 (${FACTORY}); this tool only touches that factory's markets`)
  return market
}

async function marketState(pub, m) {
  const r = (fn) => read(pub, m, marketAbi, fn)
  return {
    owner: getAddress(await r('owner')), gameId: await r('gameId'), bettingOpen: await r('bettingOpen'), settled: await r('settled'),
    canceled: await r('canceled'), refundMode: await r('refundMode'), paused: await r('paused'), assertionActive: await r('assertionActive'),
    assertionId: await r('assertionId'), pendingSpread: await r('pendingSpread'), finalSpread: await r('finalSpread'),
    bettingClosedAt: await r('bettingClosedAt'), canTriggerRefund: await r('canTriggerRefund'), refundTimeout: await r('REFUND_TIMEOUT'),
    spreadMax: await r('SPREAD_MAX'), spreadMin: await r('SPREAD_MIN'), totalPool: await r('totalPool'), seedTotal: await r('protocolSeedTotal'),
    initialZ: await r('initialZ'), currentZ: await r('currentZ'), oo: getAddress(await r('oo')),
  }
}

async function bondFor(pub, oo) {
  const min = await read(pub, oo, ooAbi, 'getMinimumBond', [USDC])
  return min < 100_000_000n ? 100_000_000n : min // contract floor MIN_BOND = 100e6 (SportsbookMarket-v1_11.sol:529-531)
}

// ── Per-command plans: pre-checks + the call to simulate ───────────────────────────────────
// Each returns { call: {address, abi, functionName, args}, describe, warnings[], after?(ctx, receipt) }.
const PLANS = {
  async 'open-market'({ pub, flags, signer, csvText, out }) {
    const gameId = flags['game-id']; if (!gameId) refuse('--game-id is required')
    if (flags.z === undefined) refuse('--z is required (4-decimal fixed point, +70000 = +7.0)')
    if (!/^[+-]?\d+$/.test(flags.z)) refuse('--z must be an integer in 4-decimal fixed point (e.g. 70000 or -35000)')
    const z = BigInt(flags.z)
    if (z < -Z_LIMIT || z > Z_LIMIT) refuse(`--z ${z} is outside +/-${Z_LIMIT} (the market's Z_MIN/Z_MAX)`)
    if (flags.seed === undefined) refuse('--seed is required (USDC per side, 1 to 1000)')
    if (!/^\d+(\.\d{1,6})?$/.test(flags.seed)) refuse('--seed must be a plain USDC amount per side, e.g. 25')
    const seed = parseUnits(flags.seed, 6)
    if (seed < SEED_MIN * 1_000_000n || seed > SEED_MAX * 1_000_000n) refuse(`--seed ${flags.seed} is outside ${SEED_MIN} to ${SEED_MAX} USDC per side`)
    const gameDate = csvGameDate(csvText, gameId)
    if (gameDate === undefined) refuse(`data/markets.csv has no row for "${gameId}". The kickoff closer needs one: add it first (scripts/add-market-row.mjs)`)
    if (gameDate === null) refuse(`the CSV row for "${gameId}" has no valid ISO gameDate; the kickoff closer could not time the close`)
    const existing = await read(pub, FACTORY, factoryAbi, 'marketByGameId', [gameId])
    if (getAddress(existing) !== '0x0000000000000000000000000000000000000000') refuse(`a market already exists for "${gameId}": ${existing}`)
    const need = seed * 2n
    const bal = await read(pub, USDC, erc20Abi, 'balanceOf', [signer])
    if (bal < need) refuse(`owner USDC ${f6(bal)} is below 2 x seed = ${f6(need)}`)
    const allow = await read(pub, USDC, erc20Abi, 'allowance', [signer, FACTORY])
    if (allow < need) refuse(`owner's USDC allowance to the factory (${f6(allow)}) is below ${f6(need)}; approve the factory first (not a command of this tool)`)
    return {
      call: { address: FACTORY, abi: factoryAbi, functionName: 'createMarket', args: [gameId, z, seed] },
      describe: `open ${gameId} at Z ${z} (${Number(z) / 10000}) with seed ${f6(seed)} USDC/side (pulls ${f6(need)} USDC); kickoff ${gameDate}`,
      warnings: [], market: null,
      async after({ receipt }) {
        const ev = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: 'MarketCreated' })[0]
        if (!ev) { out('  !! no MarketCreated event in the receipt; check the transaction'); return null }
        const m = ev.args.market
        out(`  market created: ${m}`)
        out(`  event: oracleZ ${ev.args.oracleZ}, creator ${ev.args.creator}`)
        out(`  REMINDER: set approved=yes on the "${gameId}" row of data/markets.csv so the opener records it and the kickoff closer (which closes markets owned by ${signer}) tracks it.`)
        return m
      },
      simNote(result) { out(`  would create market: ${result}`); out(`  REMINDER (after a real send): set approved=yes on the "${gameId}" row of data/markets.csv.`) },
    }
  },

  async 'close-betting'({ st }) {
    if (!st.bettingOpen) refuse('betting is already closed')
    if (st.canceled || st.settled) refuse('the market is already settled or canceled')
    return { call: 'closeBetting', describe: `close betting on ${st.gameId}`, warnings: [] }
  },
  async 'trigger-refund'({ st }) {
    if (st.settled) refuse('the market is settled; refund does not apply')
    if (st.canceled) refuse('the market is already canceled/refunded')
    if (st.bettingOpen) refuse('betting is still open; the 7-day timer has not started')
    if (!st.canTriggerRefund) refuse(`canTriggerRefund is false; eligible from ${iso(st.bettingClosedAt + st.refundTimeout)}`)
    const warnings = st.assertionActive ? ['A UMA assertion is pending on this market (proposed spread ' + st.pendingSpread + '). Refunding forfeits it: bettors get stakes back, no winners.'] : []
    return { call: 'triggerRefund', describe: `refund ${st.gameId}: stakes ${f6(st.totalPool - st.seedTotal)} USDC unlock for claims, seed ${f6(st.seedTotal)} USDC returns to the owner`, warnings }
  },
  async 'approve-bond'({ pub, st, signer, market }) {
    const allow = await read(pub, USDC, erc20Abi, 'allowance', [signer, market])
    if (allow === maxUint256) refuse('the allowance to this market is already max; nothing to do')
    return { call: { address: USDC, abi: erc20Abi, functionName: 'approve', args: [market, maxUint256] },
      describe: `approve max USDC from the owner to ${market} (the UMA bond, ${f6(await bondFor(pub, st.oo))} USDC, is pulled from the owner at requestSettlement)`, warnings: [] }
  },
  async 'request-settlement'({ pub, st, flags, signer, market }) {
    if (flags.spread === undefined) refuse('--spread is required (whole points; positive = HOME won by that margin)')
    if (!/^[+-]?\d+$/.test(flags.spread)) refuse('--spread must be a whole integer')
    const spread = BigInt(flags.spread)
    if (spread < st.spreadMin || spread > st.spreadMax) refuse(`--spread ${spread} is outside the market's ${st.spreadMin}..${st.spreadMax}`)
    if (st.bettingOpen) refuse('close betting first')
    if (st.settled || st.canceled) refuse('the market is already settled or canceled')
    if (st.assertionActive) refuse('an assertion is already pending')
    const bond = await bondFor(pub, st.oo)
    const bal = await read(pub, USDC, erc20Abi, 'balanceOf', [signer])
    if (bal < bond) refuse(`owner USDC ${f6(bal)} is below the ${f6(bond)} USDC UMA bond`)
    const allow = await read(pub, USDC, erc20Abi, 'allowance', [signer, market])
    if (allow < bond) refuse(`owner's allowance to this market (${f6(allow)}) is below the bond ${f6(bond)}; run approve-bond first`)
    return { call: { address: market, abi: marketAbi, functionName: 'requestSettlement', args: [spread] },
      describe: `propose final spread ${spread} for ${st.gameId}; posts a ${f6(bond)} USDC bond (returned if the claim stands)`,
      warnings: ['A wrong spread can be disputed and cost the bond. UMA liveness is 7200 s before execute-settlement works.'] }
  },
  async 'execute-settlement'({ pub, st }) {
    if (st.settled || st.canceled) refuse('the market is already settled or canceled')
    if (!st.assertionActive) refuse('no active assertion on this market')
    const a = await read(pub, st.oo, ooAbi, 'getAssertion', [st.assertionId])
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (!a.settled && now < a.expirationTime) refuse(`UMA liveness has not ended; earliest ${iso(a.expirationTime)}`)
    return { call: 'executeSettlement', describe: `settle ${st.gameId} at the proposed spread ${st.pendingSpread} (seed returns to the owner; winners then claim)`, warnings: [] }
  },
  async 'cancel-market'({ st }) {
    if (st.settled || st.canceled) refuse('the market is already settled or canceled')
    return { call: 'cancelMarket', describe: `cancel ${st.gameId}: refund mode on, betting closed, seed ${f6(st.seedTotal)} USDC returns to the owner`,
      warnings: ['Cancelling ends the market without a result (a pending assertion is dropped). It cannot be undone.'] }
  },
  async pause({ st }) { if (st.paused) refuse('already paused'); return { call: 'pause', describe: `pause ${st.gameId} (blocks new bets and settlement actions; claims still work)`, warnings: [] } },
  async unpause({ st }) { if (!st.paused) refuse('not paused'); return { call: 'unpause', describe: `unpause ${st.gameId}`, warnings: [] } },
}
const OWNER_ONLY = new Set(['close-betting', 'cancel-market', 'pause', 'unpause'])

// ── status (read-only, never loads the key) ────────────────────────────────────────────────
async function statusCmd({ pub, flags, out }) {
  const block = await pub.getBlock()
  const fowner = getAddress(await read(pub, FACTORY, factoryAbi, 'owner'))
  out(`block ${block.number} ${new Date(Number(block.timestamp) * 1000).toISOString()}`)
  out(`factory ${FACTORY}  owner ${fowner}${fowner === EXPECTED_OWNER ? ' (v4, as expected)' : '  !! differs from the expected v4 wallet'}`)
  const s = await snapshot(pub, fowner); printSnap(out, 'balances', s)
  out('signing key: not loaded (status never reads it)')
  if (flags.market || flags['game-id']) {
    const market = await resolveMarket(pub, flags, fowner)
    const st = await marketState(pub, market)
    out(`market ${market}  ${st.gameId}  owner ${st.owner}${st.owner === fowner ? '' : '  !! not the factory owner'}`)
    out(`  bettingOpen ${st.bettingOpen} settled ${st.settled} canceled ${st.canceled} refundMode ${st.refundMode} paused ${st.paused}`)
    out(`  assertionActive ${st.assertionActive}${st.assertionActive ? ' pendingSpread ' + st.pendingSpread : ''}  finalSpread ${st.finalSpread}`)
    out(`  Z initial ${st.initialZ} current ${st.currentZ} | pool ${f6(st.totalPool)} (seed ${f6(st.seedTotal)})`)
    out(`  bettingClosedAt ${iso(st.bettingClosedAt)}  canTriggerRefund ${st.canTriggerRefund}` + (st.bettingClosedAt > 0n ? `  refund eligible from ${iso(st.bettingClosedAt + st.refundTimeout)}` : ''))
    const ms = await snapshot(pub, fowner, market); printSnap(out, 'balances', ms)
  } else {
    const open = await read(pub, FACTORY, factoryAbi, 'getOpenMarkets')
    out(`open markets: ${open.length ? open.join(', ') : 'none'}`)
  }
  return 0
}

// ── Entry point ────────────────────────────────────────────────────────────────────────────
export async function run(argv, deps) {
  const { pub, makeWallet, loadSigner, readCsv, out = console.log } = deps
  let secrets = []
  try {
    const { cmd, flags, confirm } = parseArgs(argv)
    if (cmd === 'status') return await statusCmd({ pub, flags, out })

    const factoryOwner = getAddress(await read(pub, FACTORY, factoryAbi, 'owner'))
    out(`${cmd}  [${confirm ? 'LIVE --confirm' : 'SIMULATION, nothing will be sent'}]`)

    // Signer: simulate as the on-chain factory owner without ever loading the key; --confirm loads it in-process.
    let account = factoryOwner, wallet = null
    if (confirm) {
      const s = loadSigner(); secrets = s.secrets
      const signer = getAddress(s.account.address)
      const expected = s.productionWallet || EXPECTED_OWNER
      if (signer !== expected) refuse(`the signing key derives ${signer}, not the production wallet ${expected}`)
      if (signer !== factoryOwner) refuse(`the signing key derives ${signer}, but the factory owner is ${factoryOwner}`)
      account = signer; wallet = makeWallet(s.account)
      out(`signer: ${signer} (matches factory owner; key loaded in-process, never printed)`)
    } else {
      if (factoryOwner !== EXPECTED_OWNER) refuse(`the factory owner is ${factoryOwner}, not the expected ${EXPECTED_OWNER}; update EXPECTED_OWNER deliberately`)
      out(`signer: ${account} (simulated as the factory owner; key not loaded)`)
    }

    const ctx = { pub, flags, signer: account, out, csvText: cmd === 'open-market' ? readCsv() : null }
    if (cmd !== 'open-market') {
      ctx.market = await resolveMarket(pub, flags, account)
      ctx.st = await marketState(pub, ctx.market)
      if (OWNER_ONLY.has(cmd) && ctx.st.owner !== account) refuse(`this market is owned by ${ctx.st.owner}, not ${account}; that wallet's key is needed`)
    }
    const plan = await PLANS[cmd](ctx)
    const call = typeof plan.call === 'string' ? { address: ctx.market, abi: marketAbi, functionName: plan.call, args: [] } : plan.call

    out(`action: ${plan.describe}`)
    for (const w of plan.warnings || []) out(`  WARNING: ${w}`)

    let sim
    try { sim = await pub.simulateContract({ ...call, account }) }
    catch (e) { out(`SIMULATION FAILED: ${scrub(e.shortMessage || e.message, secrets).split('\n')[0]}`); return 1 }
    out('simulation: OK')
    if (!confirm) {
      plan.simNote?.(sim.result)
      out('nothing was sent. Re-run with --confirm to send.')
      return 0
    }

    const before = await snapshot(pub, account, cmd === 'open-market' ? null : ctx.market)
    printSnap(out, 'before', before)
    const hash = await wallet.writeContract({ ...sim.request, account: wallet.account })
    out(`tx hash: ${hash}`)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    out(`  status: ${receipt.status}  block: ${receipt.blockNumber}  gas: ${receipt.gasUsed}`)
    if (receipt.status !== 'success') { out('REVERTED on chain'); return 1 }
    const newMarket = plan.after ? await plan.after({ receipt }) : null
    const after = await snapshot(pub, account, cmd === 'open-market' ? newMarket : ctx.market)
    printSnap(out, 'after ', after)
    if (cmd === 'open-market' && newMarket) {
      const st = await marketState(pub, newMarket)
      out(`  verified: owner ${st.owner}${st.owner === account ? ' (v4)' : ' !!'}, initialZ ${st.initialZ}, seed pool ${f6(st.seedTotal)} USDC`)
    }
    return 0
  } catch (e) {
    if (e instanceof Refusal) { out(`REFUSED: ${scrub(e.message, secrets)}`); return 2 }
    out(`ERROR: ${scrub(e.shortMessage || e.message, secrets).split('\n')[0]}`); return 1
  }
}
