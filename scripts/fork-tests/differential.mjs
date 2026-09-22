// D1–D9: v1.10 vs v1.11 differential suite on a pinned Base mainnet fork.
// Every scenario runs the IDENTICAL call sequence against both deployments,
// paired into the same block so timestamps and fork state are identical.
import { acct, pub, wallet, increaseTime, USDC, erc20Abi, signAuthorization,
         derivedNonce, usdcDomain, mintUSDC, pairSend } from './lib/chain.mjs'
import { buildWorld, newPair, approveBoth, USD, ROLES } from './lib/fixture.mjs'
import { compileTestContract } from './lib/compile.mjs'
import { approveMax, createMarket } from './lib/deploy.mjs'
import { settlePair } from './lib/flow.mjs'
import { ok, eq, section, summary, stop } from './lib/report.mjs'
import { observed, ALLOWED, classifyPause, classifyOwner, SEL_MARKETPAUSED, SEL_NOTOWNER } from './lib/pair.mjs'
import { keccak256, toHex, encodeAbiParameters, decodeEventLog, encodeFunctionData } from 'viem'

const A = i => acct(i)
const OWNER = A(ROLES.OWNER), ALICE = A(ROLES.ALICE), BOB = A(ROLES.BOB),
      CAROL = A(ROLES.CAROL), RELAY = A(ROLES.RELAY), AGENT = A(ROLES.AGENT), DAVE = A(ROLES.DAVE)
const LADDER = [1, 5, 10, 18, 19, 25, 100, 500]
// Settle at +20. The 19:1 pool-ratio clamp caps |Z| at 137,247 (13.7247 points), so a
// final spread of 20 makes every GREATER bet a winner and every LESS bet a loser
// regardless of when it was placed. At +7 some LESS bets also win (7*10000 <= lockedZ),
// which silently turns a "loser" case into a winner one.
const SETTLE_SPREAD = 20n

const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const want = d => !ONLY || ONLY.has(d)

export async function runDifferential(world) {
  const zTable = []

  // ── D1 ───────────────────────────────────────────────────────────────
  if (want('D1')) {
  section('D1  placeBet both sides; Z after each bet; R6-6 ladder seeded AND seedless')
  for (const seedMode of ['seeded', 'seedless']) {
    const seed = seedMode === 'seeded' ? USD(1) : 0n
    for (const s of LADDER) {
      const p = await newPair(world, { seed, tag: `d1-${seedMode}-${s}` })
      await approveBoth(p, ALICE)
      await p.send(`D1 ${seedMode} one-sided LESS ${s} USDC`, ALICE, 'placeBet', [false, USD(s)])
      const zA = await pub.readContract({ address: p.a.market, abi: p.a.abi, functionName: 'currentZ' })
      const zB = await pub.readContract({ address: p.b.market, abi: p.b.abi, functionName: 'currentZ' })
      eq(`D1 ${seedMode} ${s} USDC: currentZ equal`, zB, zA, `Z=${zA}`)
      zTable.push({ mode: seedMode, stake: s, z: zA.toString(), equal: zA === zB })
      await p.snap(`D1 ${seedMode} ${s} USDC state`, [USD(100)])
    }
  }
  // two-sided sequence, Z checked after every bet
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd1-twosided' })
    for (const a of [ALICE, BOB, CAROL]) await approveBoth(p, a)
    const seq = [[ALICE, true, 50], [BOB, false, 30], [CAROL, true, 120], [BOB, false, 200], [ALICE, true, 7]]
    for (const [who, side, st] of seq) {
      await p.send(`D1 two-sided ${side ? 'GREATER' : 'LESS'} ${st}`, who, 'placeBet', [side, USD(st)])
      const zA = await pub.readContract({ address: p.a.market, abi: p.a.abi, functionName: 'currentZ' })
      const zB = await pub.readContract({ address: p.b.market, abi: p.b.abi, functionName: 'currentZ' })
      eq(`D1 two-sided after ${side ? 'G' : 'L'}${st}: currentZ equal`, zB, zA, `Z=${zA}`)
    }
    await p.snap('D1 two-sided final state', [USD(1), USD(100), USD(1000)])
  }

  }

  // ── D2 ───────────────────────────────────────────────────────────────
  if (want('D2')) {
  section('D2  placeBetFor via real EIP-3009 — negatives must be BYTE-IDENTICAL to v1.10 (C2 deferred)')
  {
    const dom = await usdcDomain()
    ok('D2 EIP-712 domain read from the token itself', true,
       `name="${dom.name}" version="${dom.version}" DOMAIN_SEPARATOR=${dom.onChain}`)
    const p = await newPair(world, { seed: USD(1), tag: 'd2' })
    const stake = USD(100), fee = stake * 200n / 10000n, value = stake + fee
    const pack = a => ({ validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce, salt: a.salt, v: a.v, r: a.r, s: a.s })
    // An EIP-3009 nonce is consumed per SIGNER, not per market, so the two sides
    // must use different salts or the second redemption would fail on a burnt
    // nonce. The resulting AuthorizationUsed nonces are tokenised so the logs
    // still compare byte for byte.
    const mkAuth = async (market, o = {}) => signAuthorization({
      signer: AGENT, market, value: o.value ?? value, salt: o.salt, greaterThan: o.greaterThan ?? true,
      validAfter: o.validAfter, validBefore: o.validBefore, nonceOverride: o.nonceOverride })
    const saltA = keccak256(toHex('d2-salt-A')), saltB = keccak256(toHex('d2-salt-B'))
    const authA = await mkAuth(p.a.market, { salt: saltA })
    const authB = await mkAuth(p.b.market, { salt: saltB })
    p.addToken('<AUTH_NONCE_1>', authA.nonce, authB.nonce)

    await p.sendEach('D2 placeBetFor happy path (relay submits, AGENT signs)', RELAY, 'placeBetFor',
                     [AGENT.address, true, stake, pack(authA)], [AGENT.address, true, stake, pack(authB)])
    await p.snap('D2 state after placeBetFor', [USD(100)])
    const betA = await pub.readContract({ address: p.a.market, abi: p.a.abi, functionName: 'getBet', args: [0n] })
    const betB = await pub.readContract({ address: p.b.market, abi: p.b.abi, functionName: 'getBet', args: [0n] })
    eq('D2 bet.bettor == AGENT on both', [betA.bettor, betB.bettor], [AGENT.address, AGENT.address])

    // ── negatives: revert data must be IDENTICAL to v1.10 (C2 is deferred) ──
    const now = (await pub.getBlock()).timestamp
    const neg = async (label, optsA, optsB, argsFn) => {
      const aA = await mkAuth(p.a.market, optsA), aB = await mkAuth(p.b.market, optsB)
      const [argA, argB] = argsFn ? argsFn(aA, aB) : [[AGENT.address, true, stake, pack(aA)], [AGENT.address, true, stake, pack(aB)]]
      await p.callEach(label, RELAY, 'placeBetFor', argA, argB)
    }
    const rnd = keccak256(toHex('x402-random-nonce'))
    await neg('D2- random x402 nonce -> BadAuthorizationNonce',
              { salt: keccak256(toHex('d2-r-A')), nonceOverride: rnd }, { salt: keccak256(toHex('d2-r-B')), nonceOverride: rnd })
    await p.callEach('D2- side flip (signed GREATER, submitted LESS) -> BadAuthorizationNonce', RELAY, 'placeBetFor',
                     [AGENT.address, false, stake, pack(authA)], [AGENT.address, false, stake, pack(authB)])
    await p.callEach('D2- bettor = address(0) -> InvalidBettor', RELAY, 'placeBetFor',
                     ['0x0000000000000000000000000000000000000000', true, stake, pack(authA)],
                     ['0x0000000000000000000000000000000000000000', true, stake, pack(authB)])
    await p.callEach('D2- replay of a used authorization -> Circle string', RELAY, 'placeBetFor',
                     [AGENT.address, true, stake, pack(authA)], [AGENT.address, true, stake, pack(authB)])
    await neg('D2- expired authorization -> Circle string',
              { salt: keccak256(toHex('d2-e-A')), validBefore: now - 10n }, { salt: keccak256(toHex('d2-e-B')), validBefore: now - 10n })
    await neg('D2- not yet valid authorization -> Circle string',
              { salt: keccak256(toHex('d2-f-A')), validAfter: now + 100000n }, { salt: keccak256(toHex('d2-f-B')), validAfter: now + 100000n })
    await neg('D2- stake does not match the signed value -> Circle string',
              { salt: keccak256(toHex('d2-w-A')) }, { salt: keccak256(toHex('d2-w-B')) },
              (aA, aB) => [[AGENT.address, true, USD(200), pack(aA)], [AGENT.address, true, USD(200), pack(aB)]])
  }

  }

  // ── D3 ───────────────────────────────────────────────────────────────
  if (want('D3')) {
  section('D3  getMarketEV / simulatePayout across pool states, seeded and seedless')
  for (const seedMode of ['seeded', 'seedless']) {
    const seed = seedMode === 'seeded' ? USD(1) : 0n
    const p = await newPair(world, { seed, tag: `d3-${seedMode}` })
    for (const a of [ALICE, BOB]) await approveBoth(p, a)
    const probes = [USD(1), USD(10), USD(100), USD(1000)]
    await p.snap(`D3 ${seedMode} empty-pool quotes`, probes)
    await p.send(`D3 ${seedMode} bet G100`, ALICE, 'placeBet', [true, USD(100)])
    await p.snap(`D3 ${seedMode} one-sided quotes`, probes)
    await p.send(`D3 ${seedMode} bet L60`, BOB, 'placeBet', [false, USD(60)])
    await p.snap(`D3 ${seedMode} two-sided quotes`, probes)
    await p.send(`D3 ${seedMode} bet L40`, BOB, 'placeBet', [false, USD(40)])
    await p.snap(`D3 ${seedMode} balanced quotes`, probes)
    for (const st of probes) for (const side of [true, false]) {
      await p.call(`D3 ${seedMode} getMarketEV(${st},${side})`, ALICE, 'getMarketEV', [st, side])
      await p.call(`D3 ${seedMode} simulatePayout(${st},${side})`, ALICE, 'simulatePayout', [st, side])
    }
  }

  }

  // ── D4 ───────────────────────────────────────────────────────────────
  if (want('D4')) {
  section('D4  full UMA settlement seeded + seedless; claimPayout / claimAllPayouts / claimPayouts')
  for (const seedMode of ['seeded', 'seedless']) {
    const seed = seedMode === 'seeded' ? USD(1) : 0n
    const p = await newPair(world, { seed, tag: `d4-${seedMode}` })
    for (const a of [ALICE, BOB, CAROL, DAVE]) await approveBoth(p, a)
    await p.send(`D4 ${seedMode} ALICE G100`, ALICE, 'placeBet', [true, USD(100)])
    await p.send(`D4 ${seedMode} BOB L100`,  BOB,  'placeBet', [false, USD(100)])
    await settlePair(p, OWNER, SETTLE_SPREAD, `D4 ${seedMode}`)
    await p.snap(`D4 ${seedMode} settled state`, [USD(100)])
    await p.send(`D4 ${seedMode} winner claimPayout(0)`, ALICE, 'claimPayout', [0n])
    await p.snap(`D4 ${seedMode} after claimPayout`, [USD(100)])
    const balA = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE.address] })
    ok(`D4 ${seedMode} winner was paid (balances compared in snap)`, true, `ALICE USDC=${balA}`)
    await p.call(`D4 ${seedMode} losing LESS bet claimPayout(1) -> NoPayout`, BOB, 'claimPayout', [1n])
  }
  // mixed winners / losers / uneven stakes, claimAllPayouts and claimPayouts
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd4-mixed' })
    for (const a of [ALICE, BOB, CAROL, DAVE]) await approveBoth(p, a)
    await p.send('D4mix ALICE G250',  ALICE, 'placeBet', [true,  USD(250)])
    await p.send('D4mix BOB   L75',   BOB,   'placeBet', [false, USD(75)])
    await p.send('D4mix CAROL G33',   CAROL, 'placeBet', [true,  USD(33)])
    await p.send('D4mix DAVE  L410',  DAVE,  'placeBet', [false, USD(410)])
    await p.send('D4mix ALICE L12',   ALICE, 'placeBet', [false, USD(12)])
    await settlePair(p, OWNER, SETTLE_SPREAD, 'D4mix')
    await p.snap('D4mix settled state', [USD(100)])
    await p.send('D4mix ALICE claimAllPayouts', ALICE, 'claimAllPayouts', [])
    await p.snap('D4mix after ALICE claimAllPayouts', [USD(100)])
    await p.send('D4mix CAROL claimPayouts([2])', CAROL, 'claimPayouts', [[2n]])
    await p.snap('D4mix after CAROL claimPayouts', [USD(100)])
    await p.call('D4mix BOB claimPayouts([1]) -> NoPayout', BOB, 'claimPayouts', [[1n]])
    await p.call('D4mix ALICE claimPayout(0) again -> AlreadyClaimed', ALICE, 'claimPayout', [0n])
  }

  }

  // ── D5 ───────────────────────────────────────────────────────────────
  if (want('D5')) {
  section('D5  cancelMarket / triggerRefund / sweepUnclaimed / claim after expiry / recoverStuckBond')
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd5-cancel' })
    for (const a of [ALICE, BOB]) await approveBoth(p, a)
    await p.send('D5 ALICE G100', ALICE, 'placeBet', [true, USD(100)])
    await p.send('D5 BOB L50',    BOB,   'placeBet', [false, USD(50)])
    await p.send('D5 cancelMarket', OWNER, 'cancelMarket', [])
    await p.snap('D5 after cancelMarket', [USD(100)])
    await p.send('D5 ALICE refund claimPayout(0)', ALICE, 'claimPayout', [0n])
    await p.snap('D5 after refund claim', [USD(100)])
  }
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd5-refund' })
    for (const a of [ALICE, BOB]) await approveBoth(p, a)
    await p.send('D5 ALICE G100', ALICE, 'placeBet', [true, USD(100)])
    await p.send('D5 BOB L50',    BOB,   'placeBet', [false, USD(50)])
    await p.send('D5 closeBetting', OWNER, 'closeBetting', [])
    await p.call('D5 triggerRefund before 7 days -> RefundTimeoutNotReached', DAVE, 'triggerRefund', [])
    await increaseTime(7 * 24 * 3600 + 10)
    await p.send('D5 triggerRefund after 7 days (permissionless)', DAVE, 'triggerRefund', [])
    await p.snap('D5 after triggerRefund', [USD(100)])
    await p.send('D5 BOB refund claimPayout(1)', BOB, 'claimPayout', [1n])
    await p.snap('D5 after BOB refund', [USD(100)])
    await increaseTime(90 * 24 * 3600 + 10)
    await p.call('D5 claim after 90 days -> ClaimWindowExpired', ALICE, 'claimPayout', [0n])
    await p.send('D5 sweepUnclaimed after 90 days', OWNER, 'sweepUnclaimed', [])
    await p.snap('D5 after sweepUnclaimed', [USD(100)])
  }
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd5-bond' })
    for (const a of [ALICE, BOB]) await approveBoth(p, a)
    await p.send('D5 ALICE G100', ALICE, 'placeBet', [true, USD(100)])
    // strand some USDC in the market, then recover it
    const w = wallet(DAVE)
    for (const m of [p.a.market, p.b.market]) {
      const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [m, USD(25)] })
      await pub.waitForTransactionReceipt({ hash: h })
    }
    await p.send('D5 recoverStuckBond(25 USDC -> OWNER)', OWNER, 'recoverStuckBond', [USD(25), OWNER.address])
    await p.snap('D5 after recoverStuckBond', [USD(100)])
    await p.call('D5 recoverStuckBond above recoverable -> AmountExceedsRecoverable', OWNER, 'recoverStuckBond', [USD(9999), OWNER.address])
  }

  }

  // ── D6 ───────────────────────────────────────────────────────────────
  if (want('D6')) {
  section('D6  pause behaviour — category (ii) differences expected; PE-1 claims still work')
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd6' })
    for (const a of [ALICE, BOB]) await approveBoth(p, a)
    await p.send('D6 ALICE G100', ALICE, 'placeBet', [true, USD(100)])
    await p.send('D6 BOB L100',   BOB,   'placeBet', [false, USD(100)])
    await p.send('D6 owner pause()', OWNER, 'pause', [])
    await p.snap('D6 state while paused', [USD(100)])
    const stake = USD(10), fee = stake * 200n / 10000n
    const salt = keccak256(toHex('d6-salt'))
    const aA = await signAuthorization({ signer: AGENT, market: p.a.market, value: stake + fee, salt, greaterThan: true })
    const aB = await signAuthorization({ signer: AGENT, market: p.b.market, value: stake + fee, salt, greaterThan: true })
    const pk = a => ({ validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce, salt: a.salt, v: a.v, r: a.r, s: a.s })
    await p.call('D6 placeBet while paused',        ALICE, 'placeBet', [true, USD(10)], classifyPause)
    await p.callEach('D6 placeBetFor while paused', RELAY, 'placeBetFor',
                     [AGENT.address, true, stake, pk(aA)], [AGENT.address, true, stake, pk(aB)], classifyPause)
    await p.call('D6 requestSettlement while paused', OWNER, 'requestSettlement', [SETTLE_SPREAD], classifyPause)
    await p.call('D6 executeSettlement while paused', OWNER, 'executeSettlement', [], classifyPause)
    await p.call('D6 openMarket while paused',        OWNER, 'openMarket', ['X', 0n], classifyPause)
    await p.send('D6 owner unpause()', OWNER, 'unpause', [])
    await settlePair(p, OWNER, SETTLE_SPREAD, 'D6')
    await p.send('D6 owner pause() after settlement', OWNER, 'pause', [])
    await p.send('D6 PE-1 claimPayout(0) while paused after settlement', ALICE, 'claimPayout', [0n])
    await p.snap('D6 after paused claim', [USD(100)])
  }

  }

  // ── D7 ───────────────────────────────────────────────────────────────
  if (want('D7')) {
  section('D7  non-owner calls to onlyOwner functions — category (iii) differences expected')
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd7' })
    await approveBoth(p, ALICE)
    await p.send('D7 ALICE G100', ALICE, 'placeBet', [true, USD(100)])
    for (const [fn, args] of [['closeBetting', []], ['cancelMarket', []], ['pause', []], ['unpause', []],
                              ['sweepUnclaimed', []], ['recoverStuckBond', [USD(1), DAVE.address]],
                              ['openMarket', ['Y', 0n]],
                              ['transferOwnership', [DAVE.address]]])
      await p.call(`D7 non-owner ${fn}()`, DAVE, fn, args, classifyOwner)
  }

  }

  // ── D8 ───────────────────────────────────────────────────────────────
  if (want('D8')) {
  section('D8  MAX_BETS boundary: 1000 bets, 1001st -> MarketFull, then settle')
  {
    const p = await newPair(world, { seed: USD(1), tag: 'd8' })
    const fillers = [ALICE, BOB, CAROL, DAVE]
    for (const a of fillers) await approveBoth(p, a)
    const MAXB = await pub.readContract({ address: p.b.market, abi: p.b.abi, functionName: 'MAX_BETS' })
    eq('D8 MAX_BETS', MAXB, 1000n)
    const t0 = Date.now()
    // Bulk fill via a TEST-ONLY helper contract (test-contracts/BetFiller.sol). Placing
    // 2000 bets as 2000 EOA transactions collapses hardhat's block production on a fork;
    // looping placeBet() inside a few transactions builds the identical state in seconds.
    // The market sees ordinary external placeBet calls either way.
    const filler = compileTestContract('BetFiller.sol', 'BetFiller')
    const wOwner = wallet(OWNER)
    const fh = await wOwner.deployContract({ abi: filler.abi, bytecode: filler.bytecode, args: [] })
    const fAddr = (await pub.waitForTransactionReceipt({ hash: fh })).contractAddress
    await mintUSDC(fAddr, USD(1000000))
    const CHUNK = 100
    for (const mk of [{ m: p.a.market, abi: p.a.abi }, { m: p.b.market, abi: p.b.abi }]) {
      const ah = await wOwner.writeContract({ address: fAddr, abi: filler.abi, functionName: 'approveMarket',
                                              args: [USDC, mk.m], gas: 200000n })
      await pub.waitForTransactionReceipt({ hash: ah })
      for (let done = 0; done < 1000; done += CHUNK) {
        const h = await wOwner.writeContract({ address: fAddr, abi: filler.abi, functionName: 'fill',
          args: [mk.m, BigInt(CHUNK), USD(1), BigInt(done)], gas: 190000000n })
        const rr = await pub.waitForTransactionReceipt({ hash: h })
        if (rr.status !== 'success') throw new Error('BetFiller.fill reverted at ' + done)
      }
    }
    console.log(`  (filled 1000 bets on each side in ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    const cA = await pub.readContract({ address: p.a.market, abi: p.a.abi, functionName: 'getMarketStatus' })
    const cB = await pub.readContract({ address: p.b.market, abi: p.b.abi, functionName: 'getMarketStatus' })
    eq('D8 betsRemaining == 0 on both', [cA[4], cB[4]], [0n, 0n])
    await p.call('D8 1001st bet -> MarketFull', ALICE, 'placeBet', [true, USD(1)])
    const r = await settlePairWithGas(p, OWNER, SETTLE_SPREAD)
    ok('D8 settlement at 1000 bets completed on both', true,
       `executeSettlement gas: v1.10=${r.gasA} v1.11=${r.gasB} (+${r.gasB - r.gasA})`)
    await p.snap('D8 full state at 1000 bets after settlement', [USD(100)])
  }

  }

  // ── D9 ───────────────────────────────────────────────────────────────
  if (want('D9')) {
  section('D9  factory end-to-end: Factory v1.5+Deployer v1.0 vs Factory v1.6+Deployer v1.1')
  {
    const gameId = 'NFL-2026-01-15-HOME-Chiefs-AWAY-49ers-D9'
    await pub.request({ method: 'evm_setAutomine', params: [false] })
    const wa = wallet(OWNER), wb = wallet(OWNER)
    const ha = await wa.writeContract({ address: world.setA.factory, abi: world.artsA.SportsbookFactory.abi,
                                        functionName: 'createMarket', args: [gameId, -35000n, USD(1)], gas: 30000000n })
    const hb = await wb.writeContract({ address: world.setB.factory, abi: world.artsB.SportsbookFactory.abi,
                                        functionName: 'createMarket', args: [gameId, -35000n, USD(1)], gas: 30000000n })
    await pub.request({ method: 'evm_mine', params: [] })
    await pub.request({ method: 'evm_setAutomine', params: [true] })
    const ra = await pub.getTransactionReceipt({ hash: ha }), rb = await pub.getTransactionReceipt({ hash: hb })
    eq('D9 both createMarket succeeded', [ra.status, rb.status], ['success', 'success'])
    const mcA = ra.logs.find(l => l.address.toLowerCase() === world.setA.factory.toLowerCase())
    const mcB = rb.logs.find(l => l.address.toLowerCase() === world.setB.factory.toLowerCase())
    eq('D9 MarketCreated topic0 identical', mcB.topics[0], mcA.topics[0], mcA.topics[0])
    eq('D9 MarketCreated creator topic identical', mcB.topics[2], mcA.topics[2])
    eq('D9 MarketCreated data identical (gameId, oracleZ, bounds, fee)', mcB.data, mcA.data)
    const decA = decodeEventLog({ abi: world.artsA.SportsbookFactory.abi, data: mcA.data, topics: mcA.topics })
    const decB = decodeEventLog({ abi: world.artsB.SportsbookFactory.abi, data: mcB.data, topics: mcB.topics })
    console.log('  MarketCreated v1.5 args:', JSON.stringify(decA.args, (_, v) => typeof v === 'bigint' ? v.toString() : v))
    console.log('  MarketCreated v1.6 args:', JSON.stringify(decB.args, (_, v) => typeof v === 'bigint' ? v.toString() : v))
    const mA = decA.args.market, mB = decB.args.market
    const ownA = await pub.readContract({ address: mA, abi: world.artsA.SportsbookMarket.abi, functionName: 'owner' })
    const ownB = await pub.readContract({ address: mB, abi: world.artsB.SportsbookMarket.abi, functionName: 'owner' })
    eq('D9 ownership handed factory -> creator on both', [ownA, ownB], [OWNER.address, OWNER.address])
    const infoA = await pub.readContract({ address: world.setA.factory, abi: world.artsA.SportsbookFactory.abi, functionName: 'getMarketInfo', args: [mA] })
    const infoB = await pub.readContract({ address: world.setB.factory, abi: world.artsB.SportsbookFactory.abi, functionName: 'getMarketInfo', args: [mB] })
    eq('D9 getMarketInfo identical', infoB.map(String), infoA.map(String), JSON.stringify(infoA.map(String)))
    const openA = await pub.readContract({ address: world.setA.factory, abi: world.artsA.SportsbookFactory.abi, functionName: 'getOpenMarkets' })
    const openB = await pub.readContract({ address: world.setB.factory, abi: world.artsB.SportsbookFactory.abi, functionName: 'getOpenMarkets' })
    eq('D9 getOpenMarkets same shape/length', openB.length, openA.length, `${openA.length} open markets each`)
    const cntA = await pub.readContract({ address: world.setA.factory, abi: world.artsA.SportsbookFactory.abi, functionName: 'getMarketCount' })
    const cntB = await pub.readContract({ address: world.setB.factory, abi: world.artsB.SportsbookFactory.abi, functionName: 'getMarketCount' })
    eq('D9 getMarketCount equal', cntB, cntA, String(cntA))
  }

  }

  return { zTable }
}

async function settlePairWithGas(p, owner, spread) {
  await approveBoth(p, owner)
  await p.send('D8 closeBetting (1000 bets)', owner, 'closeBetting', [])
  await p.send('D8 requestSettlement (1000 bets)', owner, 'requestSettlement', [spread], { syncTokens: true })
  await increaseTime(7300)
  const r = await p.send('D8 executeSettlement (1000 bets)', owner, 'executeSettlement', [])
  return { gasA: r.a.receipt.gasUsed, gasB: r.b.receipt.gasUsed }
}
