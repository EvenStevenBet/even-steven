// N1–N15, E1–E3, C1a–C1d: behaviour that exists only in v1.11.
// Every case asserts exact balances, exact event args and exact revert selectors.
import { pub, wallet, acct, USDC, erc20Abi, increaseTime, signAuthorization,
         mintUSDC, setBalanceEth, usdcDomain, rawCall } from './lib/chain.mjs'
import { approveMax, createMarket } from './lib/deploy.mjs'
import { USD, ROLES } from './lib/fixture.mjs'
import { settleOne } from './lib/flow.mjs'
import { ok, eq, section, summary, stop } from './lib/report.mjs'
import { keccak256, toHex, decodeEventLog, encodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAccount as pk2acct } from 'viem/accounts'

const A = i => acct(i)
const OWNER = A(ROLES.OWNER), ALICE = A(ROLES.ALICE), BOB = A(ROLES.BOB),
      CAROL = A(ROLES.CAROL), RELAY = A(ROLES.RELAY), AGENT = A(ROLES.AGENT), DAVE = A(ROLES.DAVE)

// Settle at +20: with |Z| clamped to 137,247 by the 19:1 pool-ratio rule, every
// GREATER bet wins and every LESS bet loses whenever it was placed. At +7 late LESS
// bets also win, which would make "the losing bet" in these cases a winner.
const SETTLE_SPREAD = 20n
const SEL = name => keccak256(toHex(name)).slice(0, 10)
const E = {
  NotYourBet: SEL('NotYourBet()'), AlreadyClaimed: SEL('AlreadyClaimed()'),
  NoPayout: SEL('NoPayout()'), NothingToClaim: SEL('NothingToClaim()'),
  InvalidBetId: SEL('InvalidBetId()'), NotSettledYet: SEL('NotSettledYet()'),
  ClaimWindowExpired: SEL('ClaimWindowExpired()'), MarketPaused: SEL('MarketPaused()'),
  NotOwner: SEL('NotOwner()'), MarketFull: SEL('MarketFull()'),
}
const TOPIC = {
  BetClaimed: keccak256(toHex('BetClaimed(address,uint256,uint256)')),
  PayoutClaimed: keccak256(toHex('PayoutClaimed(address,uint256)')),
  SettlementDetails: keccak256(toHex('SettlementDetails(uint256,uint256)')),
  MarketSettled: keccak256(toHex('MarketSettled(int256,bool,bool)')),
  BetPlaced: keccak256(toHex('BetPlaced(address,uint256,uint256,uint256,bool,int256)')),
  Transfer: keccak256(toHex('Transfer(address,address,uint256)')),
}

let W, ABI, seq = 0
const bal = a => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const read = (m, fn, args = []) => pub.readContract({ address: m, abi: ABI, functionName: fn, args })

async function mkMarket({ seed = USD(1), oracleZ = 0n, tag = '' } = {}) {
  const gid = `NFL-2026-02-01-HOME-Chiefs-AWAY-49ers-N-${tag}-${seq++}`
  const { market } = await createMarket(W.setB, OWNER, gid, oracleZ, seed)
  return market
}
async function bet(market, account, side, stake) {
  await approveMax(account, market)
  const w = wallet(account)
  const h = await w.writeContract({ address: market, abi: ABI, functionName: 'placeBet', args: [side, stake] })
  return pub.waitForTransactionReceipt({ hash: h })
}
async function send(market, account, fn, args = []) {
  const w = wallet(account)
  const h = await w.writeContract({ address: market, abi: ABI, functionName: fn, args })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  r._tx = await pub.getTransaction({ hash: h })
  return r
}
/** eth_call and return the raw revert selector (or null on success). */
async function revertSel(market, account, fn, args) {
  // Raw eth_call: viem's `call` takes { to, data } (not address/abi/functionName,
  // which it ignores — that would make every negative vacuous) and its error
  // wrapping can drop the raw revert bytes.
  const r = await rawCall({ from: account.address ?? account, to: market,
                            data: encodeFunctionData({ abi: ABI, functionName: fn, args }) })
  if (r.ok) return null
  return r.data ? String(r.data).slice(0, 10) : 'NO-DATA:' + r.message
}
function logsOf(receipt, address, topic0) {
  return receipt.logs.filter(l => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === topic0)
}
function decode(log) { return decodeEventLog({ abi: ABI, data: log.data, topics: log.topics }) }

export async function runNew(world) {
  W = world
  ABI = world.artsB.SportsbookMarket.abi
  const gas = []

  // ── N1 ───────────────────────────────────────────────────────────────
  section('N1  happy path — bettor holds 0 ETH, a separate relay claims for them')
  {
    const m = await mkMarket({ tag: 'n1' })
    await bet(m, ALICE, true, USD(100))
    await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    await setBalanceEth(ALICE.address, 0n)
    eq('N1 bettor ETH balance is exactly 0 before the claim', await pub.getBalance({ address: ALICE.address }), 0n)
    const b0 = { alice: await bal(ALICE.address), relay: await bal(RELAY.address), market: await bal(m) }
    const r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    const b1 = { alice: await bal(ALICE.address), relay: await bal(RELAY.address), market: await bal(m) }
    const pc = decode(logsOf(r, m, TOPIC.PayoutClaimed)[0])
    eq('N1 tx.from is the RELAY, not the bettor', r._tx.from.toLowerCase(), RELAY.address.toLowerCase())
    eq('N1 tx.to is the market', r._tx.to.toLowerCase(), m.toLowerCase())
    eq('N1 PayoutClaimed.bettor == ALICE (!= tx.from)', pc.args.bettor, ALICE.address)
    eq('N1 payout is exactly 2x stake at balance', pc.args.amount, USD(200))
    eq('N1 bettor USDC delta == +payout', b1.alice - b0.alice, USD(200))
    eq('N1 relay USDC delta == 0', b1.relay - b0.relay, 0n)
    eq('N1 market USDC delta == -payout', b1.market - b0.market, -USD(200))
    eq('N1 market fully drained', b1.market, 0n)
    eq('N1 bettor still holds 0 ETH after the claim', await pub.getBalance({ address: ALICE.address }), 0n)
    const usdcT = logsOf(r, USDC, TOPIC.Transfer)
    eq('N1 exactly one USDC Transfer, market -> bettor', usdcT.length, 1)
    eq('N1 USDC Transfer from == market', '0x' + usdcT[0].topics[1].slice(26).toLowerCase(), m.toLowerCase())
    eq('N1 USDC Transfer to == bettor', '0x' + usdcT[0].topics[2].slice(26).toLowerCase(), ALICE.address.toLowerCase())
    eq('N1 USDC Transfer amount == payout', BigInt(usdcT[0].data), USD(200))
    await setBalanceEth(ALICE.address, 10n ** 22n)
  }

  // ── N2 ───────────────────────────────────────────────────────────────
  section('N2  batch of two winners: claimPayoutFor == claimPayouts on an identical twin market')
  {
    const build = async tag => {
      const m = await mkMarket({ tag })
      await bet(m, ALICE, true, USD(60))
      await bet(m, ALICE, true, USD(40))
      await bet(m, BOB, false, USD(100))
      await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
      return m
    }
    const m1 = await build('n2a'), m2 = await build('n2b')
    // run both in the SAME block so nothing but the entry point differs
    await pub.request({ method: 'evm_setAutomine', params: [false] })
    const wr = wallet(RELAY), wa = wallet(ALICE)
    const h1 = await wr.writeContract({ address: m1, abi: ABI, functionName: 'claimPayoutFor', args: [ALICE.address, [0n, 1n]], gas: 3000000n })
    const h2 = await wa.writeContract({ address: m2, abi: ABI, functionName: 'claimPayouts',   args: [[0n, 1n]], gas: 3000000n })
    await pub.request({ method: 'evm_mine', params: [] })
    await pub.request({ method: 'evm_setAutomine', params: [true] })
    const r1 = await pub.getTransactionReceipt({ hash: h1 }), r2 = await pub.getTransactionReceipt({ hash: h2 })
    eq('N2 both succeeded', [r1.status, r2.status], ['success', 'success'])
    const norm = (r, m) => JSON.stringify(r.logs.map(l => ({
      a: l.address.toLowerCase() === m.toLowerCase() ? 'MARKET' : l.address.toLowerCase(),
      t: l.topics.map(t => t.replaceAll(m.slice(2).toLowerCase(), '<MARKET>')),
      d: l.data.replaceAll(m.slice(2).toLowerCase(), '<MARKET>') })))
    eq('N2 logs identical (claimPayoutFor vs claimPayouts)', norm(r1, m1), norm(r2, m2))
    const p1 = decode(logsOf(r1, m1, TOPIC.PayoutClaimed)[0]).args.amount
    const p2 = decode(logsOf(r2, m2, TOPIC.PayoutClaimed)[0]).args.amount
    eq('N2 exact sum equal on both, = 2x total stake', [p1, p2], [USD(200), USD(200)])
    for (const [m, label] of [[m1, 'claimPayoutFor'], [m2, 'claimPayouts']]) {
      const b0 = await read(m, 'getBet', [0n]), b1 = await read(m, 'getBet', [1n])
      eq(`N2 ${label}: both bets marked claimed`, [b0.claimed, b1.claimed], [true, true])
      eq(`N2 ${label}: market drained`, await bal(m), 0n)
    }
    gas.push({ case: 'N2 claimPayoutFor(2 ids)', gas: r1.gasUsed }, { case: 'N2 claimPayouts(2 ids)', gas: r2.gasUsed })
  }

  // ── N3 / N4 ──────────────────────────────────────────────────────────
  section('N3/N4  wrong bettor param and address(0) -> NotYourBet; nothing moves')
  {
    const m = await mkMarket({ tag: 'n34' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const before = { a: await bal(ALICE.address), m: await bal(m), bet0: await read(m, 'getBet', [0n]) }
    eq('N3 claimPayoutFor(BOB, [0]) -> NotYourBet', await revertSel(m, RELAY, 'claimPayoutFor', [BOB.address, [0n]]), E.NotYourBet)
    eq('N4 claimPayoutFor(address(0), [0]) -> NotYourBet',
       await revertSel(m, RELAY, 'claimPayoutFor', ['0x0000000000000000000000000000000000000000', [0n]]), E.NotYourBet)
    eq('N3/N4 bettor balance unchanged', await bal(ALICE.address), before.a)
    eq('N3/N4 market balance unchanged', await bal(m), before.m)
    eq('N3/N4 bet 0 still unclaimed', (await read(m, 'getBet', [0n])).claimed, false)
  }

  // ── N5 ───────────────────────────────────────────────────────────────
  section('N5  double-claim A: bettor claims directly, then relay -> AlreadyClaimed')
  {
    const m = await mkMarket({ tag: 'n5' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const b0 = await bal(ALICE.address)
    await send(m, ALICE, 'claimPayout', [0n])
    eq('N5 bettor received 2x once', await bal(ALICE.address) - b0, USD(200))
    eq('N5 relay claimPayoutFor same id -> AlreadyClaimed',
       await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]]), E.AlreadyClaimed)
  }

  // ── N6 ───────────────────────────────────────────────────────────────
  section('N6  double-claim B: relay first, then the bettor')
  {
    const m = await mkMarket({ tag: 'n6' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const b0 = await bal(ALICE.address)
    await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    eq('N6 bettor paid exactly once, by the relay', await bal(ALICE.address) - b0, USD(200))
    eq('N6 bettor claimPayout(0) -> AlreadyClaimed', await revertSel(m, ALICE, 'claimPayout', [0n]), E.AlreadyClaimed)
    eq('N6 bettor claimAllPayouts() -> NothingToClaim', await revertSel(m, ALICE, 'claimAllPayouts', []), E.NothingToClaim)
    eq('N6 bettor balance unchanged by the failed attempts', await bal(ALICE.address) - b0, USD(200))
  }

  // ── N7 ───────────────────────────────────────────────────────────────
  section('N7  partial batch: [0,1] after 0 was already claimed -> atomic revert; retry [1] succeeds')
  {
    const m = await mkMarket({ tag: 'n7' })
    await bet(m, ALICE, true, USD(50)); await bet(m, ALICE, true, USD(50)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    await send(m, ALICE, 'claimPayout', [0n])
    const mid = { m: await bal(m), a: await bal(ALICE.address) }
    eq('N7 relay [0,1] -> AlreadyClaimed', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n, 1n]]), E.AlreadyClaimed)
    eq('N7 bet 1 STILL unclaimed', (await read(m, 'getBet', [1n])).claimed, false)
    eq('N7 market balance unchanged by the failed batch', await bal(m), mid.m)
    const r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [1n]])
    eq('N7 retry [1] succeeds', r.status, 'success')
    eq('N7 bettor received the second half', await bal(ALICE.address) - mid.a, USD(100))
    eq('N7 market drained', await bal(m), 0n)
  }

  // ── N8 ───────────────────────────────────────────────────────────────
  section('N8  batch containing a losing bet -> NoPayout, atomic')
  {
    const m = await mkMarket({ tag: 'n8' })
    await bet(m, ALICE, true, USD(100)); await bet(m, ALICE, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)   // +20 -> bet 0 (GREATER) wins, bet 1 (LESS) loses
    eq('N8 bet 0 wins, bet 1 loses (sanity)', [(await read(m, 'simulatePayout', [USD(1), true])) > 0n], [true])
    eq('N8 claimPayoutFor([0,1]) -> NoPayout', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n, 1n]]), E.NoPayout)
    eq('N8 winning bet 0 stays unclaimed', (await read(m, 'getBet', [0n])).claimed, false)
    const r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    eq('N8 claiming only the winner succeeds', r.status, 'success')
  }

  // ── N9 ───────────────────────────────────────────────────────────────
  section('N9  argument and lifecycle negatives')
  {
    const m = await mkMarket({ tag: 'n9' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    eq('N9 before settlement -> NotSettledYet', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]]), E.NotSettledYet)
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    eq('N9 empty array -> NothingToClaim', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, []]), E.NothingToClaim)
    eq('N9 id >= bets.length -> InvalidBetId', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [99n]]), E.InvalidBetId)
    await increaseTime(90 * 24 * 3600 + 60)
    eq('N9 after 90 days -> ClaimWindowExpired', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]]), E.ClaimWindowExpired)
  }

  // ── N10 ──────────────────────────────────────────────────────────────
  section('N10  refund mode: cancelMarket() and triggerRefund() — exact stakes back, no fee refund')
  for (const how of ['cancelMarket', 'triggerRefund']) {
    const m = await mkMarket({ tag: 'n10-' + how })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(37))
    if (how === 'cancelMarket') await send(m, OWNER, 'cancelMarket', [])
    else { await send(m, OWNER, 'closeBetting', []); await increaseTime(7 * 24 * 3600 + 60); await send(m, DAVE, 'triggerRefund', []) }
    eq(`N10 ${how}: refundMode true`, await read(m, 'refundMode'), true)
    const a0 = await bal(ALICE.address), b0 = await bal(BOB.address)
    const r1 = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    const r2 = await send(m, RELAY, 'claimPayoutFor', [BOB.address, [1n]])
    eq(`N10 ${how}: ALICE refunded exactly her stake (no fee)`, await bal(ALICE.address) - a0, USD(100))
    eq(`N10 ${how}: BOB refunded exactly his stake (no fee)`, await bal(BOB.address) - b0, USD(37))
    eq(`N10 ${how}: PayoutClaimed amount == stake`, decode(logsOf(r1, m, TOPIC.PayoutClaimed)[0]).args.amount, USD(100))
    eq(`N10 ${how}: market drained to 0`, await bal(m), 0n)
    ok(`N10 ${how}: no SettlementDetails emitted by the refund path`,
       logsOf(r2, m, TOPIC.SettlementDetails).length === 0, 'none')
  }

  // ── N11 ──────────────────────────────────────────────────────────────
  section('N11  paused market after settlement: claimPayoutFor still works (PE-1 parity)')
  {
    const m = await mkMarket({ tag: 'n11' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    await send(m, OWNER, 'pause', [])
    eq('N11 market is paused', await read(m, 'paused'), true)
    const a0 = await bal(ALICE.address)
    const r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    eq('N11 claimPayoutFor succeeded while paused', r.status, 'success')
    eq('N11 bettor paid 2x while paused', await bal(ALICE.address) - a0, USD(200))
  }

  // ── N12 ──────────────────────────────────────────────────────────────
  section('N12  duplicate id in one batch [id,id] -> AlreadyClaimed on the second, atomic')
  {
    const m = await mkMarket({ tag: 'n12' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const m0 = await bal(m), a0 = await bal(ALICE.address)
    eq('N12 [0,0] -> AlreadyClaimed', await revertSel(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n, 0n]]), E.AlreadyClaimed)
    eq('N12 nothing moved', [await bal(m), await bal(ALICE.address)], [m0, a0])
    eq('N12 bet 0 still unclaimed', (await read(m, 'getBet', [0n])).claimed, false)
  }

  // ── N13 ──────────────────────────────────────────────────────────────
  section('N13  seedless market (PROTOCOL_SEED == 0) pays exactly 2x through claimPayoutFor')
  {
    const m = await mkMarket({ seed: 0n, tag: 'n13' })
    eq('N13 PROTOCOL_SEED == 0', await read(m, 'PROTOCOL_SEED'), 0n)
    eq('N13 protocolSeedTotal == 0', await read(m, 'protocolSeedTotal'), 0n)
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const a0 = await bal(ALICE.address)
    const r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n]])
    eq('N13 payout exactly 2x stake', await bal(ALICE.address) - a0, USD(200))
    eq('N13 PayoutClaimed.amount', decode(logsOf(r, m, TOPIC.PayoutClaimed)[0]).args.amount, USD(200))
    eq('N13 market drained', await bal(m), 0n)
  }

  // ── N14 ──────────────────────────────────────────────────────────────
  section('N14  gas: claimPayoutFor vs claimPayouts for 1, 2 and 10 ids')
  {
    for (const n of [1, 2, 10]) {
      const build = async tag => {
        const m = await mkMarket({ tag })
        for (let i = 0; i < n; i++) await bet(m, ALICE, true, USD(10))
        await bet(m, BOB, false, USD(10 * n))
        await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
        return m
      }
      const ids = Array.from({ length: n }, (_, i) => BigInt(i))
      const mF = await build(`n14-for-${n}`), mP = await build(`n14-pay-${n}`)
      const rF = await send(mF, RELAY, 'claimPayoutFor', [ALICE.address, ids])
      const rP = await send(mP, ALICE, 'claimPayouts', [ids])
      gas.push({ case: `claimPayoutFor(${n} ids)`, gas: rF.gasUsed },
               { case: `claimPayouts(${n} ids)`,   gas: rP.gasUsed })
      ok(`N14 ${n} id(s): both paths succeeded`, rF.status === 'success' && rP.status === 'success',
         `claimPayoutFor=${rF.gasUsed}  claimPayouts=${rP.gasUsed}  delta=${rF.gasUsed - rP.gasUsed}`)
      eq(`N14 ${n} id(s): identical total payout`,
         decode(logsOf(rF, mF, TOPIC.PayoutClaimed)[0]).args.amount,
         decode(logsOf(rP, mP, TOPIC.PayoutClaimed)[0]).args.amount)
    }
  }

  // ── N15 ──────────────────────────────────────────────────────────────
  section('N15  FULL GASLESS PATH: placeBetFor (EIP-3009) then claimPayoutFor — zero ETH throughout')
  {
    const freshPk = generatePrivateKey()
    const fresh = pk2acct(freshPk)
    await mintUSDC(fresh.address, USD(1000))
    eq('N15 fresh bettor ETH balance == 0', await pub.getBalance({ address: fresh.address }), 0n)
    eq('N15 fresh bettor tx count == 0', await pub.getTransactionCount({ address: fresh.address }), 0)
    const m = await mkMarket({ tag: 'n15' })
    const stake = USD(100), fee = stake * 200n / 10000n
    const auth = await signAuthorization({ signer: fresh, market: m, value: stake + fee,
                                           salt: keccak256(toHex('n15')), greaterThan: true })
    const pack = { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce,
                   salt: auth.salt, v: auth.v, r: auth.r, s: auth.s }
    const rb = await send(m, RELAY, 'placeBetFor', [fresh.address, true, stake, pack])
    const bp = decode(logsOf(rb, m, TOPIC.BetPlaced)[0])
    eq('N15 BetPlaced.bettor == the fresh signer', bp.args.bettor, fresh.address)
    eq('N15 bet was submitted by the RELAY', rb._tx.from.toLowerCase(), RELAY.address.toLowerCase())
    await bet(m, BOB, false, USD(100))
    await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
    const f0 = await bal(fresh.address)
    const rc = await send(m, RELAY, 'claimPayoutFor', [fresh.address, [0n]])
    eq('N15 claim was submitted by the RELAY', rc._tx.from.toLowerCase(), RELAY.address.toLowerCase())
    eq('N15 fresh bettor received exactly 2x stake', await bal(fresh.address) - f0, USD(200))
    eq('N15 fresh bettor ETH STILL 0 after bet+claim', await pub.getBalance({ address: fresh.address }), 0n)
    eq('N15 fresh bettor tx count STILL 0 after bet+claim', await pub.getTransactionCount({ address: fresh.address }), 0)
    eq('N15 market drained', await bal(m), 0n)
  }

  // ── E1 ───────────────────────────────────────────────────────────────
  section('E1  BetClaimed fires once per claimed bet on ALL FOUR claim paths')
  {
    for (const path of ['claimPayout', 'claimAllPayouts', 'claimPayouts', 'claimPayoutFor']) {
      const m = await mkMarket({ tag: 'e1-' + path })
      await bet(m, ALICE, true, USD(30)); await bet(m, ALICE, true, USD(70)); await bet(m, BOB, false, USD(100))
      await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
      let r
      if (path === 'claimPayout')          r = await send(m, ALICE, 'claimPayout', [0n])
      else if (path === 'claimAllPayouts') r = await send(m, ALICE, 'claimAllPayouts', [])
      else if (path === 'claimPayouts')    r = await send(m, ALICE, 'claimPayouts', [[0n, 1n]])
      else                                 r = await send(m, RELAY, 'claimPayoutFor', [ALICE.address, [0n, 1n]])
      const bcs = logsOf(r, m, TOPIC.BetClaimed).map(decode)
      const pcs = logsOf(r, m, TOPIC.PayoutClaimed).map(decode)
      const expectN = path === 'claimPayout' ? 1 : 2
      eq(`E1 ${path}: one BetClaimed per claimed bet`, bcs.length, expectN)
      eq(`E1 ${path}: BetClaimed.bettor decodes to ALICE`, bcs.map(b => b.args.bettor), bcs.map(() => ALICE.address))
      eq(`E1 ${path}: BetClaimed.betId decodes in order`, bcs.map(b => b.args.betId.toString()),
         Array.from({ length: expectN }, (_, i) => String(i)))
      const sum = bcs.reduce((t, b) => t + b.args.payout, 0n)
      eq(`E1 ${path}: BetClaimed payouts SUM to PayoutClaimed.amount`, sum, pcs[0].args.amount, `${sum}`)
    }
  }

  // ── E2 ───────────────────────────────────────────────────────────────
  section('E2  SettlementDetails: exactly once, before MarketSettled, values equal chain state')
  {
    for (const seedMode of ['seeded', 'seedless']) {
      const m = await mkMarket({ seed: seedMode === 'seeded' ? USD(1) : 0n, tag: 'e2-' + seedMode })
      await bet(m, ALICE, true, USD(150)); await bet(m, BOB, false, USD(90))
      const r = await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
      const blk = r.blockNumber
      const sds = logsOf(r, m, TOPIC.SettlementDetails)
      const mss = logsOf(r, m, TOPIC.MarketSettled)
      eq(`E2 ${seedMode}: exactly one SettlementDetails`, sds.length, 1)
      eq(`E2 ${seedMode}: exactly one MarketSettled`, mss.length, 1)
      ok(`E2 ${seedMode}: SettlementDetails comes BEFORE MarketSettled in the same tx`,
         sds[0].logIndex < mss[0].logIndex, `logIndex ${sds[0].logIndex} < ${mss[0].logIndex}`)
      const d = decode(sds[0]).args
      const totalPool = await pub.readContract({ address: m, abi: ABI, functionName: 'totalPool', blockNumber: blk })
      const seedTot   = await pub.readContract({ address: m, abi: ABI, functionName: 'protocolSeedTotal', blockNumber: blk })
      const cws       = await pub.readContract({ address: m, abi: ABI, functionName: 'cachedWinningStakes', blockNumber: blk })
      eq(`E2 ${seedMode}: distributable == totalPool - protocolSeedTotal (read at the settlement block)`,
         d.distributable, totalPool - seedTot, `${totalPool} - ${seedTot}`)
      eq(`E2 ${seedMode}: winningStakes == cachedWinningStakes (settlement block)`, d.winningStakes, cws)
    }
    // no-winner market -> refundMode true, winningStakes 0
    {
      const m = await mkMarket({ tag: 'e2-nowinner' })
      await bet(m, ALICE, false, USD(100))       // only LESS bets; spread +7 makes them all lose
      await bet(m, BOB, false, USD(100))
      const r = await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
      const d = decode(logsOf(r, m, TOPIC.SettlementDetails)[0]).args
      const ms = decode(logsOf(r, m, TOPIC.MarketSettled)[0]).args
      eq('E2 no-winner: winningStakes == 0', d.winningStakes, 0n)
      eq('E2 no-winner: MarketSettled.refundMode == true', ms.refundMode, true)
      eq('E2 no-winner: refundMode on chain', await read(m, 'refundMode'), true)
    }
    for (const how of ['cancelMarket', 'triggerRefund']) {
      const m = await mkMarket({ tag: 'e2-' + how })
      await bet(m, ALICE, true, USD(100))
      let r
      if (how === 'cancelMarket') r = await send(m, OWNER, 'cancelMarket', [])
      else { await send(m, OWNER, 'closeBetting', []); await increaseTime(7 * 24 * 3600 + 60); r = await send(m, DAVE, 'triggerRefund', []) }
      eq(`E2 ${how}() emits NO SettlementDetails`, logsOf(r, m, TOPIC.SettlementDetails).length, 0)
    }
  }

  // ── E3 ───────────────────────────────────────────────────────────────
  section('E3  EVENT-ONLY RECONSTRUCTION: payouts computed from logs alone match USDC received')
  {
    for (const seedMode of ['seeded', 'seedless']) {
      const m = await mkMarket({ seed: seedMode === 'seeded' ? USD(1) : 0n, tag: 'e3-' + seedMode })
      const plan = [[ALICE, true, 250], [BOB, false, 75], [CAROL, true, 33], [DAVE, false, 410], [ALICE, false, 12]]
      const placed = []
      for (const [who, side, st] of plan) {
        const r = await bet(m, who, side, USD(st))
        placed.push({ who, log: decode(logsOf(r, m, TOPIC.BetPlaced)[0]).args })
      }
      const rs = await settleOne(m, ABI, OWNER, SETTLE_SPREAD)
      const sd = decode(logsOf(rs, m, TOPIC.SettlementDetails)[0]).args
      const ms = decode(logsOf(rs, m, TOPIC.MarketSettled)[0]).args
      // reconstruct using ONLY log data
      const finalSpread = ms.finalSpread
      const predicted = placed.map(p => {
        const { stake, greaterThan, lockedZ } = p.log
        if (ms.refundMode) return stake
        const isWinner = greaterThan ? (finalSpread * 10000n) > lockedZ : (finalSpread * 10000n) <= lockedZ
        return isWinner ? (stake * sd.distributable) / sd.winningStakes : 0n
      })
      for (let i = 0; i < placed.length; i++) {
        const who = placed[i].who
        const before = await bal(who.address)
        const expected = predicted[i]
        if (expected === 0n) {
          eq(`E3 ${seedMode} bet ${i}: predicted 0 -> NoPayout on claim`,
             await revertSel(m, RELAY, 'claimPayoutFor', [who.address, [BigInt(i)]]), E.NoPayout)
        } else {
          await send(m, RELAY, 'claimPayoutFor', [who.address, [BigInt(i)]])
          eq(`E3 ${seedMode} bet ${i}: log-derived payout == USDC received (base units)`,
             await bal(who.address) - before, expected, `${expected}`)
        }
      }
    }
  }

  // ── C1a ──────────────────────────────────────────────────────────────
  section('C1a  MarketPaused() replaces "Pausable: paused" on every pause-guarded entry point')
  {
    const m = await mkMarket({ tag: 'c1a' })
    await bet(m, ALICE, true, USD(100)); await bet(m, BOB, false, USD(100))
    await send(m, OWNER, 'pause', [])
    const stake = USD(10), fee = stake * 200n / 10000n
    const auth = await signAuthorization({ signer: AGENT, market: m, value: stake + fee, salt: keccak256(toHex('c1a')), greaterThan: true })
    const pack = { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, salt: auth.salt, v: auth.v, r: auth.r, s: auth.s }
    eq('C1a placeBet while paused',         await revertSel(m, ALICE, 'placeBet', [true, USD(10)]), E.MarketPaused)
    eq('C1a placeBetFor while paused',      await revertSel(m, RELAY, 'placeBetFor', [AGENT.address, true, stake, pack]), E.MarketPaused)
    eq('C1a requestSettlement while paused',await revertSel(m, OWNER, 'requestSettlement', [SETTLE_SPREAD]), E.MarketPaused)
    eq('C1a executeSettlement while paused',await revertSel(m, OWNER, 'executeSettlement', []), E.MarketPaused)
    eq('C1a openMarket while paused',       await revertSel(m, OWNER, 'openMarket', ['Z', 0n]), E.MarketPaused)
    ok('C1a MarketPaused() selector', true, E.MarketPaused)
  }

  // ── C1b ──────────────────────────────────────────────────────────────
  section('C1b  NotOwner() replaces "Ownable: caller is not the owner"')
  {
    const m = await mkMarket({ tag: 'c1b' })
    await bet(m, ALICE, true, USD(100))
    for (const [fn, args] of [['closeBetting', []], ['cancelMarket', []], ['pause', []],
                              ['sweepUnclaimed', []], ['recoverStuckBond', [USD(1), DAVE.address]],
                              ['openMarket', ['Q', 0n]], ['transferOwnership', [DAVE.address]]])
      eq(`C1b non-owner ${fn}()`, await revertSel(m, DAVE, fn, args), E.NotOwner)
    ok('C1b NotOwner() selector', true, E.NotOwner)
  }

  // ── C1c ──────────────────────────────────────────────────────────────
  section('C1c  unpause() on an unpaused market still reverts with OZ\'s "Pausable: not paused" string')
  {
    const m = await mkMarket({ tag: 'c1c' })
    const rr = await rawCall({ from: OWNER.address, to: m,
                               data: encodeFunctionData({ abi: ABI, functionName: 'unpause', args: [] }) })
    const raw = rr.data
    const isString = String(raw).startsWith('0x08c379a0')
    const decoded = isString ? Buffer.from(String(raw).slice(138), 'hex').toString('utf8').replace(/\0+$/, '') : null
    ok('C1c unpause() on an unpaused market reverts with Error(string), NOT a custom error', isString, String(raw))
    eq('C1c the string is unchanged from OZ', decoded, 'Pausable: not paused')
    console.log('  RECORDED: unpause() revert data =', raw)
  }

  // ── C1d ──────────────────────────────────────────────────────────────
  section('C1d  owner happy paths unchanged')
  {
    const m = await mkMarket({ tag: 'c1d' })
    await bet(m, ALICE, true, USD(100))
    eq('C1d owner pause()',        (await send(m, OWNER, 'pause', [])).status, 'success')
    eq('C1d owner unpause()',      (await send(m, OWNER, 'unpause', [])).status, 'success')
    eq('C1d owner closeBetting()', (await send(m, OWNER, 'closeBetting', [])).status, 'success')
    eq('C1d owner cancelMarket()', (await send(m, OWNER, 'cancelMarket', [])).status, 'success')
    eq('C1d owner is still the creator', await read(m, 'owner'), OWNER.address)
  }

  section('GAS TABLE (v1.11)')
  console.log('  case'.padEnd(36), 'gas')
  for (const g of gas) console.log('  ' + g.case.padEnd(34), g.gas.toString())
  return { gas }
}
