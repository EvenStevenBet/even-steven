// Fork test: the skill's REAL code path against a Base mainnet fork (real Circle USDC, a v1.6
// factory and v1.11 markets deployed from our solc 0.8.20 artifacts). No keys, nothing leaves the
// machine except reads to the fork node.
//
// Bankr is mocked: /wallet/me returns the signer, /wallet/sign signs with a throwaway key (or a
// throwaway ERC-1271 wallet's owner key). Even Steven's relay is replaced by a fork-side shim that
// takes the script's exact POST /api/bet payload and submits it to placeBetFor (65-byte) or
// placeBetForWithSignature, from a relay account that holds ETH and no USDC.
//
//   cd ../../../../scripts/fork-tests && npx hardhat node       # terminal 1
//   node scripts/fork.test.mjs                                   # terminal 2 (from this folder)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileSet, compileTestContract, V111, assertSolc } from '../../../../scripts/fork-tests/lib/compile.mjs'
import { pub, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi } from '../../../../scripts/fork-tests/lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from '../../../../scripts/fork-tests/lib/deploy.mjs'
import { ok, eq, section, summary } from '../../../../scripts/fork-tests/lib/report.mjs'
import { encodeAbiParameters, getAddress, decodeEventLog, size } from 'viem'
import { createCli } from './even-steven.mjs'

const USD = (n) => BigInt(Math.round(n * 1e6))
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const wrap = (idx, sig) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [idx, sig])
const signTd = (acc, td) => acc.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType,
  message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } })

console.log('solc      :', assertSolc())
console.log('fork block:', (await pub.getBlockNumber()).toString())
await assertFreshActors(5)
const [OWNER, RELAY, EOA, WOWNER, OPP] = [0, 1, 2, 3, 4].map(acct)
for (const a of [OWNER, RELAY, OPP]) await setBalanceEth(a.address, 10n ** 22n)
await mintUSDC(OWNER.address, USD(1000)); await mintUSDC(EOA.address, USD(100)); await mintUSDC(OPP.address, USD(100))

const arts = compileSet(V111, 200)
const set = await deployVersionSet(arts, OWNER)
const M = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)
// one distinct pair of teams per market so the script's game matching is unambiguous
const newMarket = async (home, away) => (await createMarket(set, OWNER, `NFL-2026-11-01-HOME-${home}-AWAY-${away}`, -35000n, USD(1))).market

const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
const wh = await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, 0] })
const SW = (await pub.waitForTransactionReceipt({ hash: wh })).contractAddress
await mintUSDC(SW, USD(100))

/** Runs prepare + confirm through the script's real code path. `bettor` is the Bankr wallet address. */
async function drive({ market, bettor, signFn, relayMode, game, side = 'away', stake = '10', key = 'bk_FORK_TEST_not_a_real_key_000111' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-fork-'))
  const cfg = path.join(dir, 'config.json'); fs.writeFileSync(cfg, JSON.stringify({ apiKey: key }))
  const seen = { relayBody: null, fn: null, hash: null, outputs: [] }
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null
    const reply = (status, b) => ({ status, text: async () => JSON.stringify(b) })
    if (u.pathname === '/wallet/me') return reply(200, { success: true, wallets: [{ chain: 'evm', address: bettor.toLowerCase() }] })
    if (u.pathname === '/wallet/sign') return reply(200, { success: true, signature: await signFn(body.typedData), signer: bettor.toLowerCase(), signatureType: 'eth_signTypedData_v4' })
    if (u.pathname === '/api/bet') {
      const p = body; seen.relayBody = p
      const sigLen = (p.signature.length - 2) / 2
      const fn = relayMode === 'auto' ? (sigLen === 65 ? 'placeBetFor' : 'placeBetForWithSignature') : relayMode
      seen.fn = fn
      const common = { validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), nonce: p.nonce, salt: p.salt }
      const auth = fn === 'placeBetFor'
        ? { ...common, v: Number('0x' + p.signature.slice(130, 132)), r: '0x' + p.signature.slice(2, 66), s: '0x' + p.signature.slice(66, 130) }
        : { ...common, signature: p.signature }
      try {
        const h = await wallet(RELAY).writeContract({ address: p.marketAddress, abi: M, functionName: fn, args: [p.bettor, p.greaterThan, BigInt(p.stake), auth] })
        const r = await pub.waitForTransactionReceipt({ hash: h }); seen.hash = h
        const bp = r.logs.filter((l) => l.address.toLowerCase() === p.marketAddress.toLowerCase())
          .map((l) => { try { return decodeEventLog({ abi: M, data: l.data, topics: l.topics }) } catch { return null } }).find((e) => e?.eventName === 'BetPlaced')
        return reply(200, { success: true, betId: bp.args.betId.toString(), bettor: bp.args.bettor, fee: bp.args.fee.toString(), lockedZ: bp.args.lockedZ.toString(), lockedZDisplay: String(Number(bp.args.lockedZ) / 10000), txHash: h })
      } catch (e) {
        return reply(422, { error: 'AuthorizationRejected', reason: 'InvalidSignature', usdcRevert: (e.shortMessage || '').slice(0, 80) })
      }
    }
    throw new Error('unexpected ' + url)
  }
  const blk = await pub.getBlock()
  const cli = createCli({ env: { BANKR_CONFIG: cfg, ES_STATE_DIR: path.join(dir, 'state') }, now: () => Number(blk.timestamp), fetchImpl,
    publicClient: pub, factory: set.factory, log: (l) => seen.outputs.push(l), randomId: () => 'f0f0f0f0' })
  const c1 = await cli.run(['bet', '--prepare', game, side, stake])
  const c2 = c1 === 0 ? await cli.run(['bet', '--confirm', 'f0f0f0f0']) : -1
  return { c1, c2, seen, text: seen.outputs.join('\n'), key }
}

const betsOf = (market, who) => pub.readContract({ address: market, abi: M, functionName: 'getBetsByAddress', args: [who] })
const bet0 = (market, id) => pub.readContract({ address: market, abi: M, functionName: 'getBet', args: [id] })

// ---- F1: EOA, 65-byte signature, placeBetFor (the Bankr path) ----
section('F1  EOA, 65-byte signature, relay shim -> placeBetFor')
{
  const market = await newMarket('Packers', 'Cowboys');
  const before = await bal(EOA.address), relayBefore = await bal(RELAY.address)
  const r = await drive({ market, bettor: EOA.address, signFn: (td) => signTd(EOA, td), relayMode: 'auto', game: 'Packers Cowboys' })
  eq('F1 prepare ok, confirm ok', [r.c1, r.c2], [0, 0]); if (r.c2 !== 0) console.log(r.text)
  eq('F1 relay shim used placeBetFor (65-byte signature)', r.seen.fn, 'placeBetFor')
  eq('F1 signature is 65 bytes', size(r.seen.relayBody.signature), 65)
  const ids = await betsOf(market, EOA.address); eq('F1 one bet recorded for the signer', ids.length, 1)
  const b = await bet0(market, ids[0])
  eq('F1 Bet.bettor == the signer', getAddress(b.bettor), getAddress(EOA.address))
  eq('F1 bet side is AWAY (greaterThan false)', b.greaterThan, false)
  eq('F1 stake 10 USDC', b.stake, USD(10)); eq('F1 locked line is the market line', b.lockedZ, -35000n)
  eq('F1 wallet paid exactly stake + 2% fee', before - await bal(EOA.address), USD(10.2))
  eq('F1 relay account never held USDC', await bal(RELAY.address) - relayBefore, 0n)
  eq('F1 USDC nonce spent', await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'authorizationState', args: [EOA.address, r.seen.relayBody.nonce] }), true)
  ok('F1 output names the locked line and a BaseScan link', /Bet placed\. Cowboys -3\.5/.test(r.text) && /basescan\.org\/tx\/0x/.test(r.text))
  ok('F1 the API key never appears in output', !r.text.includes(r.key))
}

// ---- F2: EOA, 65-byte signature, through placeBetForWithSignature (bytes variant) ----
section('F2  EOA, 65-byte signature, relay shim -> placeBetForWithSignature (fallback entry point)')
{
  const market = await newMarket('Bears', 'Lions'); const before = await bal(EOA.address)
  const r = await drive({ market, bettor: EOA.address, signFn: (td) => signTd(EOA, td), relayMode: 'placeBetForWithSignature', game: 'Bears Lions', side: 'home' })
  eq('F2 prepare ok, confirm ok', [r.c1, r.c2], [0, 0])
  const ids = await betsOf(market, EOA.address); eq('F2 bet recorded for the signer', ids.length, 1)
  eq('F2 bet side is HOME (greaterThan true)', (await bet0(market, ids[0])).greaterThan, true)
  eq('F2 wallet paid exactly stake + fee', before - await bal(EOA.address), USD(10.2))
}

// ---- F3: ERC-1271 wallet, wrapped (non-65-byte) signature, placeBetForWithSignature ----
section('F3  ERC-1271 wallet, wrapped non-65-byte signature, relay shim -> placeBetForWithSignature')
{
  const market = await newMarket('Jets', 'Giants'); const before = await bal(SW)
  const r = await drive({ market, bettor: SW, signFn: async (td) => wrap(0n, await signTd(WOWNER, td)), relayMode: 'auto', game: 'Jets Giants' })
  eq('F3 prepare ok, confirm ok', [r.c1, r.c2], [0, 0]); if (r.c2 !== 0) console.log(r.text)
  ok('F3 signature is not 65 bytes', size(r.seen.relayBody.signature) !== 65, String(size(r.seen.relayBody.signature)))
  eq('F3 relay shim used placeBetForWithSignature', r.seen.fn, 'placeBetForWithSignature')
  const ids = await betsOf(market, SW); eq('F3 bet recorded for the wallet contract', ids.length, 1)
  eq('F3 Bet.bettor == the ERC-1271 wallet', getAddress((await bet0(market, ids[0])).bettor), getAddress(SW))
  eq('F3 wallet paid exactly stake + fee', before - await bal(SW), USD(10.2))
}

// ---- F4: wrapped signature forced through placeBetFor must NOT work ----
section('F4  wrapped signature through placeBetFor is rejected (so the relay must pick the bytes variant)')
{
  const market = await newMarket('Eagles', 'Saints'); const before = await bal(SW)
  const r = await drive({ market, bettor: SW, signFn: async (td) => wrap(0n, await signTd(WOWNER, td)), relayMode: 'placeBetFor', game: 'Eagles Saints' })
  eq('F4 prepare ok', r.c1, 0)
  eq('F4 confirm reports failure (exit 1)', r.c2, 1)
  eq('F4 no bet recorded', (await betsOf(market, SW)).length, 0)
  eq('F4 no USDC moved', before - await bal(SW), 0n)
  ok('F4 script explains it and tells the user to prepare again', /was not placed/.test(r.text) && /prepare again/.test(r.text))
}

// ---- F5: bad signer is stopped before the relay ----
section('F5  a signature that does not recover to the wallet never reaches the relay')
{
  const market = await newMarket('Rams', 'Seahawks')
  const r = await drive({ market, bettor: EOA.address, signFn: (td) => signTd(OPP, td), relayMode: 'auto', game: 'Rams Seahawks' })
  eq('F5 confirm aborted', r.c2, 1); eq('F5 relay shim never called', r.seen.relayBody, null)
  ok('F5 output says the signature does not verify', /does not verify/.test(r.text))
}

const s = summary()
process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
