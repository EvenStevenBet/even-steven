// node --test scripts/market-ops.test.mjs
// Everything runs against mocks: no network, no key, no env file. The "signer" is a throwaway key
// generated inside the test.
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters, encodeEventTopics, getAddress, maxUint256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { run, parseArgs, scrub, csvGameDate, makeLoadSigner, factoryAbi,
         FACTORY, USDC, EXPECTED_OWNER } from './lib/market-ops-core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARKET = getAddress('0xE88E620D1aa75d55D3387a9F3Eb41723fD7c1a7C')
const NEW_MARKET = getAddress('0xC97436E5D0A2985702EC15A44Ae4fd5960B98b8f')
const OO = getAddress('0x2aBf1Bd76655de80eDB3086114315Eec75AF500c')
const ZERO = '0x0000000000000000000000000000000000000000'
const GAME = 'NFL-2026-11-26-HOME-Lions-AWAY-Bears'
const CSV = 'gameId,sport,homeTeam,awayTeam,gameDate,status,marketAddress,openLine,bettingOpensAt,notes,approved\r\n' +
  `${GAME},NFL,Lions,Bears,2026-11-26T18:00:00Z,coming_soon,,,2026-11-24T12:00:00Z,week 12,\r\n` +
  'NFL-2026-11-30-HOME-Bad-AWAY-Date,NFL,Bad,Date,11/30/2026,coming_soon,,,2026-11-24T12:00:00Z,x,\r\n'
const U = n => BigInt(Math.round(n * 1e6))
const NOW = BigInt(Math.floor(Date.now() / 1000))

// A signer for --confirm runs. Its address is made to BE the factory owner via the mock.
const KEY = generatePrivateKey()
const SIGNER = privateKeyToAccount(KEY)

function world(over = {}) {
  const w = {
    factoryOwner: SIGNER.address, marketOwner: SIGNER.address, usdc: U(1000), allowanceFactory: maxUint256, allowanceMarket: maxUint256,
    marketFor: { [GAME]: ZERO }, registered: true, simFail: null, receiptStatus: 'success',
    m: { gameId: 'NFL-2026-11-01-HOME-Broncos-AWAY-Chiefs', bettingOpen: false, settled: false, canceled: false, refundMode: false, paused: false,
      assertionActive: false, assertionId: '0x' + '11'.repeat(32), pendingSpread: 0n, finalSpread: 0n, bettingClosedAt: NOW - 8n * 86400n,
      canTriggerRefund: true, REFUND_TIMEOUT: 604800n, SPREAD_MAX: 10000n, SPREAD_MIN: -10000n, PROTOCOL_SEED: U(1), initialZ: 0n, currentZ: 0n,
      totalPool: U(2), protocolSeedTotal: U(2) },
    bond: U(500), assertion: { settled: false, expirationTime: NOW - 10n },
    ...over,
  }
  w.calls = { sim: [], sent: [], keyLoads: 0 }
  w.out = []
  w.deps = {
    out: s => w.out.push(s),
    readCsv: () => CSV,
    loadSigner: () => { w.calls.keyLoads++; return { account: SIGNER, productionWallet: w.productionWallet ?? null, secrets: [KEY] } },
    makeWallet: account => ({ account, writeContract: async req => { w.calls.sent.push(req); return '0x' + 'ab'.repeat(32) } }),
    pub: {
      getBlock: async () => ({ number: 100n, timestamp: NOW }),
      getBalance: async () => 5_000_000_000_000_000n,
      readContract: async ({ address, functionName, args = [] }) => {
        if (functionName === 'owner') return address === FACTORY ? w.factoryOwner : w.marketOwner
        if (functionName === 'marketByGameId') return w.marketFor[args[0]] ?? ZERO
        if (functionName === 'gameIdByMarket') return w.registered ? 'x' : ''
        if (functionName === 'getOpenMarkets') return []
        if (functionName === 'oo') return OO
        if (functionName === 'balanceOf') return w.usdc
        if (functionName === 'allowance') return args[1] === FACTORY ? w.allowanceFactory : w.allowanceMarket
        if (functionName === 'getMinimumBond') return w.bond
        if (functionName === 'getAssertion') return w.assertion
        if (functionName in w.m) return w.m[functionName]
        throw new Error('mock: unhandled read ' + functionName)
      },
      simulateContract: async req => {
        w.calls.sim.push(req)
        if (w.simFail) throw Object.assign(new Error('boom'), { shortMessage: w.simFail })
        return { result: req.functionName === 'createMarket' ? NEW_MARKET : undefined, request: { ...req } }
      },
      waitForTransactionReceipt: async () => {
        const logs = []
        if (w.calls.sent[0]?.functionName === 'createMarket') {
          const [gameId, z] = w.calls.sent[0].args
          logs.push({ address: FACTORY, blockNumber: 101n, transactionHash: '0x' + 'ab'.repeat(32), logIndex: 0, blockHash: '0x' + 'cd'.repeat(32), transactionIndex: 0, removed: false,
            topics: encodeEventTopics({ abi: factoryAbi, eventName: 'MarketCreated', args: { market: NEW_MARKET, creator: SIGNER.address } }),
            data: encodeAbiParameters([{ type: 'string' }, { type: 'int256' }, { type: 'int256' }, { type: 'int256' }, { type: 'uint256' }], [gameId, z, 10000n, -10000n, 200n]) })
        }
        return { status: w.receiptStatus, blockNumber: 101n, gasUsed: 123456n, logs }
      },
    },
  }
  // after a successful createMarket the new market must exist for the post-send verification
  const base = w.deps.pub.readContract
  w.deps.pub.readContract = async req => {
    if (req.address === NEW_MARKET) { if (req.functionName === 'owner') return SIGNER.address; if (req.functionName === 'gameId') return GAME }
    return base(req)
  }
  return w
}
const text = w => w.out.join('\n')
const sim = (argv, w) => run(argv, w.deps)
const OPEN = ['open-market', '--game-id', GAME, '--z', '70000', '--seed', '25']

// ── argument parsing ───────────────────────────────────────────────────────────────────────
test('parseArgs: aliases, flag whitelist, --confirm only on writes, negative values', () => {
  assert.equal(parseArgs(['state']).cmd, 'status')
  assert.equal(parseArgs(['close', '--market', MARKET]).cmd, 'close-betting')
  assert.equal(parseArgs(['open-market', '--game-id', 'g', '--z', '-35000', '--seed', '1']).flags.z, '-35000')
  assert.throws(() => parseArgs(['open-market', '--bogus', '1']), /not a flag/)
  assert.throws(() => parseArgs(['status', '--confirm']), /read-only/)
  assert.throws(() => parseArgs(['pause', '--market']), /needs a value/)
  assert.throws(() => parseArgs(['nope']), /unknown command/)
  assert.throws(() => parseArgs([]), /usage/)
})
test('a private key in argv is refused, in any position', () => {
  const k = generatePrivateKey()
  assert.throws(() => parseArgs(['pause', '--market', k]), /private key/)
  assert.throws(() => parseArgs(['pause', `--market=${k}`]), /private key/)
})

// ── simulate is the default and signs nothing ──────────────────────────────────────────────
test('simulate mode never loads the key, never creates a wallet, never sends', async () => {
  for (const argv of [OPEN, ['trigger-refund', '--market', MARKET], ['close-betting', '--market', MARKET], ['cancel-market', '--market', MARKET],
                      ['pause', '--market', MARKET], ['approve-bond', '--market', MARKET]]) {
    const w = world({ allowanceMarket: 0n, factoryOwner: EXPECTED_OWNER, marketOwner: EXPECTED_OWNER, m: { ...world().m, bettingOpen: argv[0] === 'close-betting' } })
    let wallets = 0; const mw = w.deps.makeWallet; w.deps.makeWallet = a => { wallets++; return mw(a) }
    const code = await sim(argv, w)
    assert.equal(code, 0, argv[0] + '\n' + text(w))
    assert.equal(w.calls.keyLoads, 0, argv[0] + ': key must not be loaded')
    assert.equal(wallets, 0)
    assert.equal(w.calls.sent.length, 0)
    assert.equal(w.calls.sim.length, 1)
    assert.match(text(w), /SIMULATION, nothing will be sent/)
    assert.match(text(w), /nothing was sent/)
  }
})
test('status never loads the key and sends nothing', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER, marketOwner: EXPECTED_OWNER })
  assert.equal(await sim(['status', '--market', MARKET], w), 0)
  assert.equal(w.calls.keyLoads, 0); assert.equal(w.calls.sent.length, 0); assert.equal(w.calls.sim.length, 0)
  assert.match(text(w), /key: not loaded/)
})
test('simulate mode refuses if the factory owner is not the expected v4 wallet', async () => {
  const w = world({ factoryOwner: getAddress('0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916') })
  assert.equal(await sim(['pause', '--market', MARKET], w), 2); assert.match(text(w), /expected/)
})
test('a failing simulation reports it, exits 1 and sends nothing, even with --confirm', async () => {
  const w = live({ simFail: 'execution reverted: nope' })
  assert.equal(await sim(['pause', '--market', MARKET, '--confirm'], w), 1)
  assert.match(text(w), /SIMULATION FAILED/); assert.equal(w.calls.sent.length, 0)
})

// ── signer checks on --confirm ─────────────────────────────────────────────────────────────
test('--confirm refuses when the key does not derive the factory owner', async () => {
  const w = world({ factoryOwner: getAddress('0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916') })
  w.productionWallet = SIGNER.address // matches PRODUCTION_WALLET but not the factory owner
  assert.equal(await sim(['pause', '--market', MARKET, '--confirm'], w), 2); assert.match(text(w), /factory owner/); assert.equal(w.calls.sent.length, 0)
})
test('--confirm refuses when the key does not derive PRODUCTION_WALLET', async () => {
  const w = world(); w.productionWallet = getAddress('0x6cF0A0b5282409E24dC35e2c1834f9111315603B')
  assert.equal(await sim(['pause', '--market', MARKET, '--confirm'], w), 2); assert.match(text(w), /production wallet/); assert.equal(w.calls.sent.length, 0)
})
test('--confirm without PRODUCTION_WALLET falls back to the v4 constant', async () => {
  const w = world() // SIGNER is a throwaway, not v4
  assert.equal(await sim(['pause', '--market', MARKET, '--confirm'], w), 2); assert.match(text(w), new RegExp(EXPECTED_OWNER))
})
test('a market owned by another wallet is refused for owner-only commands', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER, marketOwner: getAddress('0x2e5Ff49699f0dA2E8A6a43f34BffC1c740E67916') })
  assert.equal(await sim(['close-betting', '--market', MARKET], w), 2); assert.match(text(w), /owned by/)
})
test('a market that is not registered in Factory v1.6 is refused', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER, registered: false })
  assert.equal(await sim(['trigger-refund', '--market', MARKET], w), 2); assert.match(text(w), /not a market of Factory v1.6/)
})

// ── a successful --confirm send (signer made to equal the owner) ───────────────────────────
function live(over = {}) { const w = world(over); w.productionWallet = SIGNER.address; return w }
test('--confirm trigger-refund: simulate first, send once, print hash, block, before/after balances', async () => {
  const w = live(); w.m.assertionActive = false
  assert.equal(await sim(['trigger-refund', '--market', MARKET, '--confirm'], w), 0, text(w))
  assert.equal(w.calls.keyLoads, 1); assert.equal(w.calls.sim.length, 1); assert.equal(w.calls.sent.length, 1)
  assert.equal(w.calls.sent[0].functionName, 'triggerRefund')
  const t = text(w)
  assert.match(t, /tx hash: 0xabab/); assert.match(t, /block: 101/); assert.match(t, /before:/); assert.match(t, /after :/)
})
test('--confirm: a reverted receipt exits 1', async () => {
  const w = live({ receiptStatus: 'reverted' })
  assert.equal(await sim(['pause', '--market', MARKET, '--confirm'], w), 1); assert.match(text(w), /REVERTED/)
})
test('the key never appears in output, even when an error message contains it', async () => {
  const w = live(); w.simFail = `rpc https://base-mainnet.g.alchemy.com/v2/SECRETKEY failed ${KEY}`
  await sim(['pause', '--market', MARKET, '--confirm'], w)
  assert.ok(!text(w).includes(KEY) && !text(w).includes(KEY.slice(2)), 'key leaked')
  assert.ok(!text(w).includes('SECRETKEY'), 'rpc url leaked')
})

// ── open-market checks ─────────────────────────────────────────────────────────────────────
test('open-market: valid +70000 / 25 USDC simulates createMarket(gameId, 70000, 25e6) and prints market + approved=yes reminder', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER })
  assert.equal(await sim(OPEN, w), 0, text(w))
  assert.deepEqual(w.calls.sim[0].args, [GAME, 70000n, 25_000_000n]); assert.equal(w.calls.sim[0].address, FACTORY)
  assert.match(text(w), new RegExp(NEW_MARKET)); assert.match(text(w), /approved=yes/)
})
test('open-market --confirm sends once, reads the market from the event, verifies ownership, reminds approved=yes', async () => {
  const w = live()
  assert.equal(await sim([...OPEN, '--confirm'], w), 0, text(w))
  assert.equal(w.calls.sent.length, 1); assert.deepEqual(w.calls.sent[0].args, [GAME, 70000n, 25_000_000n])
  assert.match(text(w), new RegExp('market created: ' + NEW_MARKET)); assert.match(text(w), /approved=yes/); assert.match(text(w), /verified: owner/)
})
test('open-market: z limits are +/-5,000,000 inclusive; non-integers refused', async () => {
  for (const [z, ok] of [['5000000', true], ['-5000000', true], ['5000001', false], ['-5000001', false], ['7.5', false], ['abc', false]]) {
    const w = world({ factoryOwner: EXPECTED_OWNER })
    assert.equal(await sim(['open-market', '--game-id', GAME, '--z', z, '--seed', '25'], w), ok ? 0 : 2, z + ' ' + text(w))
  }
})
test('open-market: seed must be 1 to 1000 USDC', async () => {
  for (const [s, ok] of [['1', true], ['1000', true], ['0.999999', false], ['0', false], ['1000.000001', false], ['1001', false], ['-5', false], ['x', false]]) {
    const w = world({ factoryOwner: EXPECTED_OWNER, usdc: U(5000) })
    assert.equal(await sim(['open-market', '--game-id', GAME, '--z', '0', '--seed', s], w), ok ? 0 : 2, s + ' ' + text(w))
  }
})
test('open-market: needs a CSV row with a valid gameDate', async () => {
  let w = world({ factoryOwner: EXPECTED_OWNER })
  assert.equal(await sim(['open-market', '--game-id', 'NFL-2026-12-01-HOME-No-AWAY-Row', '--z', '0', '--seed', '1'], w), 2); assert.match(text(w), /no row/)
  w = world({ factoryOwner: EXPECTED_OWNER })
  assert.equal(await sim(['open-market', '--game-id', 'NFL-2026-11-30-HOME-Bad-AWAY-Date', '--z', '0', '--seed', '1'], w), 2); assert.match(text(w), /ISO gameDate/)
  assert.equal(csvGameDate(CSV, GAME), '2026-11-26T18:00:00Z'); assert.equal(csvGameDate(CSV, 'zzz'), undefined)
})
test('open-market: refuses when a market already exists for the gameId', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER, marketFor: { [GAME]: MARKET } })
  assert.equal(await sim(OPEN, w), 2); assert.match(text(w), /already exists/); assert.equal(w.calls.sim.length, 0)
})
test('open-market: owner USDC must cover 2x seed', async () => {
  let w = world({ factoryOwner: EXPECTED_OWNER, usdc: U(49.999999) })
  assert.equal(await sim(OPEN, w), 2); assert.match(text(w), /below 2 x seed/)
  w = world({ factoryOwner: EXPECTED_OWNER, usdc: U(50) })
  assert.equal(await sim(OPEN, w), 0)
})
test('open-market: refuses when the factory allowance is too small', async () => {
  const w = world({ factoryOwner: EXPECTED_OWNER, allowanceFactory: U(10) })
  assert.equal(await sim(OPEN, w), 2); assert.match(text(w), /allowance/)
})
test('open-market: required flags', async () => {
  for (const argv of [['open-market', '--z', '0', '--seed', '1'], ['open-market', '--game-id', GAME, '--seed', '1'], ['open-market', '--game-id', GAME, '--z', '0']]) {
    const w = world({ factoryOwner: EXPECTED_OWNER }); assert.equal(await sim(argv, w), 2)
  }
})

// ── per-command pre-checks ─────────────────────────────────────────────────────────────────
const ownerWorld = (m = {}, o = {}) => { const w = world({ factoryOwner: EXPECTED_OWNER, marketOwner: EXPECTED_OWNER, ...o }); Object.assign(w.m, m); return w }
test('close-betting: only while open', async () => {
  let w = ownerWorld({ bettingOpen: true }); assert.equal(await sim(['close-betting', '--market', MARKET], w), 0)
  w = ownerWorld({ bettingOpen: false }); assert.equal(await sim(['close-betting', '--market', MARKET], w), 2)
})
test('trigger-refund: refused when settled, canceled, betting open or timer not reached; warns on a pending assertion', async () => {
  for (const m of [{ settled: true }, { canceled: true }, { bettingOpen: true }, { canTriggerRefund: false }]) {
    const w = ownerWorld(m); assert.equal(await sim(['trigger-refund', '--market', MARKET], w), 2, JSON.stringify(m))
  }
  const w = ownerWorld({ assertionActive: true, pendingSpread: 3n })
  assert.equal(await sim(['trigger-refund', '--market', MARKET], w), 0); assert.match(text(w), /WARNING: A UMA assertion is pending/)
})
test('approve-bond: simulates approve(max) to the market; refuses if already max', async () => {
  let w = ownerWorld({}, { allowanceMarket: 0n }); assert.equal(await sim(['approve-bond', '--market', MARKET], w), 0)
  assert.equal(w.calls.sim[0].functionName, 'approve'); assert.deepEqual(w.calls.sim[0].args, [MARKET, maxUint256]); assert.equal(w.calls.sim[0].address, USDC)
  w = ownerWorld({}, { allowanceMarket: maxUint256 }); assert.equal(await sim(['approve-bond', '--market', MARKET], w), 2)
})
test('request-settlement: spread bounds, closed market, no pending assertion, bond balance and allowance', async () => {
  const ok = ['request-settlement', '--market', MARKET, '--spread', '3']
  assert.equal(await sim(ok, ownerWorld()), 0)
  { const w = ownerWorld(); await sim(ok, w); assert.deepEqual(w.calls.sim[0].args, [3n]); assert.equal(w.calls.sim[0].functionName, 'requestSettlement') }
  assert.equal(await sim(['request-settlement', '--market', MARKET, '--spread', '10001'], ownerWorld()), 2)
  assert.equal(await sim(['request-settlement', '--market', MARKET, '--spread', '2.5'], ownerWorld()), 2)
  assert.equal(await sim(['request-settlement', '--market', MARKET], ownerWorld()), 2)
  assert.equal(await sim(ok, ownerWorld({ bettingOpen: true })), 2)
  assert.equal(await sim(ok, ownerWorld({ assertionActive: true })), 2)
  assert.equal(await sim(ok, ownerWorld({}, { usdc: U(499) })), 2)
  assert.equal(await sim(ok, ownerWorld({}, { allowanceMarket: U(100) })), 2)
})
test('execute-settlement: needs an active assertion whose liveness has ended', async () => {
  const cmd = ['execute-settlement', '--market', MARKET]
  assert.equal(await sim(cmd, ownerWorld({ assertionActive: true })), 0)
  assert.equal(await sim(cmd, ownerWorld({ assertionActive: false })), 2)
  assert.equal(await sim(cmd, ownerWorld({ assertionActive: true }, { assertion: { settled: false, expirationTime: NOW + 3600n } })), 2)
  assert.equal(await sim(cmd, ownerWorld({ assertionActive: true }, { assertion: { settled: true, expirationTime: NOW + 3600n } })), 0)
  assert.equal(await sim(cmd, ownerWorld({ assertionActive: true, settled: true })), 2)
})
test('cancel-market: refused once settled or canceled; warns it is irreversible', async () => {
  let w = ownerWorld(); assert.equal(await sim(['cancel-market', '--market', MARKET], w), 0); assert.match(text(w), /cannot be undone/)
  assert.equal(await sim(['cancel-market', '--market', MARKET], ownerWorld({ canceled: true })), 2)
  assert.equal(await sim(['cancel-market', '--market', MARKET], ownerWorld({ settled: true })), 2)
})
test('pause / unpause are mutually guarded', async () => {
  assert.equal(await sim(['pause', '--market', MARKET], ownerWorld({ paused: false })), 0)
  assert.equal(await sim(['pause', '--market', MARKET], ownerWorld({ paused: true })), 2)
  assert.equal(await sim(['unpause', '--market', MARKET], ownerWorld({ paused: true })), 0)
  assert.equal(await sim(['unpause', '--market', MARKET], ownerWorld({ paused: false })), 2)
})
test('--game-id resolves through the factory; an unknown gameId is refused', async () => {
  const w = ownerWorld({ bettingOpen: true }, { marketFor: { [GAME]: MARKET } })
  assert.equal(await sim(['close-betting', '--game-id', GAME], w), 0); assert.equal(w.calls.sim[0].address, MARKET)
  assert.equal(await sim(['close-betting', '--game-id', 'nope'], ownerWorld({ bettingOpen: true })), 2)
  assert.equal(await sim(['close-betting', '--market', MARKET, '--game-id', GAME], ownerWorld({ bettingOpen: true })), 2)
})

// ── key handling ───────────────────────────────────────────────────────────────────────────
test('loadSigner reads the env file into locals only: process.env is untouched', () => {
  const before = JSON.stringify(process.env)
  const load = makeLoadSigner({ readFile: () => `PRIVATE_KEY=${KEY}\nPRODUCTION_WALLET=${SIGNER.address}\n`, envPath: '/nowhere', parseEnv: s => Object.fromEntries(s.split('\n').filter(Boolean).map(l => l.split('='))) })
  const s = load()
  assert.equal(s.account.address, SIGNER.address); assert.equal(s.productionWallet, SIGNER.address)
  assert.equal(JSON.stringify(process.env), before); assert.equal(process.env.PRIVATE_KEY, undefined)
})
test('loadSigner errors never echo file contents', () => {
  for (const body of ['PRIVATE_KEY=notakey', '']) {
    const load = makeLoadSigner({ readFile: () => body, envPath: '/x', parseEnv: s => Object.fromEntries(s.split('\n').filter(Boolean).map(l => l.split('='))) })
    assert.throws(load, e => !String(e.message).includes('notakey'))
  }
  const missing = makeLoadSigner({ readFile: () => { throw new Error('ENOENT /Users/x/.even-steven/bot.env') }, envPath: '/x', parseEnv: () => ({}) })
  assert.throws(missing, e => !/bot\.env/.test(e.message))
})
test('source guard: the scripts spawn no child process and never assign process.env', () => {
  for (const f of ['market-ops.mjs', 'lib/market-ops-core.mjs']) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8')
    assert.ok(!/child_process|\b(execSync|execFileSync|spawnSync|spawn|execFile|exec|fork)\s*\(/.test(src), f + ' must not use child processes')
    assert.ok(!/process\.env\s*(\.\w+|\[[^\]]+\])\s*=[^=]/.test(src), f + ' must not write process.env')
    assert.ok(!/console\.(log|error)\([^)]*(PRIVATE_KEY|privateKey|\bkey\b)/i.test(src), f + ' must not print the key')
  }
})
test('scrub removes urls, 64-hex strings and exact secrets', () => {
  assert.equal(scrub('see https://x.y/z?k=1 and ' + '0x' + 'a'.repeat(64)), 'see <url> and <hex64>')
  assert.equal(scrub('secret=abc123', ['abc123']), 'secret=<redacted>')
})
