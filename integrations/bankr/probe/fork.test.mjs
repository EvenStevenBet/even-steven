// Fork test: does OUR contract path work for a signer whose signature is not 65 bytes?
//
// A minimal ERC-1271 mock wallet (scripts/fork-tests/test-contracts/TestSmartWallet.sol)
// returns the magic value only for a valid inner ECDSA signature, wrapped as
// abi.encode(ownerIndex, sig). We sign a USDC ReceiveWithAuthorization digest with the
// wallet's owner key, wrap it, and relay it through placeBetForWithSignature on a
// SportsbookMarket v1.11 deployed on a Base mainnet fork, with the real Circle USDC.
// This is the path a Bankr smart-wallet signer would take if its signature is not 65 bytes.
//
// Needs the local fork node running (see README). No keys: every account is generated
// fresh and funded on the fork only. Nothing here can send a mainnet transaction.
//
//   cd ../../../scripts/fork-tests && npx hardhat node      # terminal 1
//   node fork.test.mjs                                       # terminal 2
import { compileSet, compileTestContract, V111, assertSolc } from '../../../scripts/fork-tests/lib/compile.mjs'
import { pub, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi,
         usdcDomain, derivedNonce } from '../../../scripts/fork-tests/lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from '../../../scripts/fork-tests/lib/deploy.mjs'
import { ok, eq, section, summary } from '../../../scripts/fork-tests/lib/report.mjs'
import { keccak256, toHex, encodeAbiParameters, getAddress, decodeEventLog } from 'viem'

const USD = n => BigInt(Math.round(n * 1e6))
const STAKE = USD(1), FEE = STAKE * 200n / 10000n, COST = STAKE + FEE   // 1,020,000
const RWA = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }
const bal = a => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const wrap = (idx, sig) => encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [idx, sig])

console.log('solc      :', assertSolc())
console.log('fork block:', (await pub.getBlockNumber()).toString())

await assertFreshActors(4)
const [OWNER, RELAY, WOWNER, STRANGER] = [0, 1, 2, 3].map(acct)
for (const a of [OWNER, RELAY]) await setBalanceEth(a.address, 10n ** 22n)
await mintUSDC(OWNER.address, USD(1000))                  // fork-only funded; seeds the market

const arts = compileSet(V111, 200)                          // v1.11, runs=200, shanghai
const set = await deployVersionSet(arts, OWNER)
const M = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)
const { market } = await createMarket(set, OWNER, 'NFL-2026-05-01-HOME-Bankr-AWAY-Probe-0', 0n, USD(1))

const art = compileTestContract('TestSmartWallet.sol', 'TestSmartWallet')
const wh = await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [WOWNER.address, 0] })
const W = (await pub.waitForTransactionReceipt({ hash: wh })).contractAddress
await mintUSDC(W, COST)

const { domain } = await usdcDomain()
const validBefore = (await pub.getBlock()).timestamp + 3600n
const salt = keccak256(toHex('bankr-probe-fork'))
const nonce = derivedNonce(salt, true)
const sign = (signer, from) => signer.signTypedData({ domain, types: RWA, primaryType: 'ReceiveWithAuthorization',
  message: { from, to: market, value: COST, validAfter: 0n, validBefore, nonce } })
const authOf = sig => ({ validAfter: 0n, validBefore, nonce, salt, signature: sig })
const relay = args => wallet(RELAY).writeContract({ address: market, abi: M, functionName: 'placeBetForWithSignature', args })

section('F1  ERC-1271 wallet, wrapped (non-65-byte) signature, via placeBetForWithSignature')
const inner = await sign(WOWNER, W)
const envelope = wrap(0n, inner)
console.log('  inner ECDSA:', (inner.length - 2) / 2, 'bytes   envelope:', (envelope.length - 2) / 2, 'bytes')
ok('F1 envelope is not 65 bytes (relay would pick placeBetForWithSignature)', (envelope.length - 2) / 2 !== 65)
eq('F1 wallet is a contract', ((await pub.getCode({ address: W })).length - 2) / 2 > 0, true)

// negatives first, each simulated so they cannot burn the nonce
const sim = async sig => pub.simulateContract({ account: RELAY, address: market, abi: M, functionName: 'placeBetForWithSignature', args: [W, true, STAKE, authOf(sig)] })
const rejects = async (name, sig) => { try { await sim(sig); ok(name, false, 'simulation succeeded') } catch (e) { ok(name, /invalid signature/i.test(e.message || e.shortMessage || ''), (e.shortMessage || '').split('\n')[0].slice(0, 90)) } }
await rejects('F1 inner signature by a stranger key is rejected', wrap(0n, await sign(STRANGER, W)))
await rejects('F1 wrong ownerIndex is rejected', wrap(1n, inner))
await rejects('F1 raw 65-byte inner signature (no envelope) is rejected by the wallet', inner)

const before = await bal(W)
const h = await relay([W, true, STAKE, authOf(envelope)])
const r = await pub.waitForTransactionReceipt({ hash: h })
eq('F1 placeBetForWithSignature mined', r.status, 'success')
const bp = r.logs.filter(l => l.address.toLowerCase() === market.toLowerCase())
  .map(l => { try { return decodeEventLog({ abi: M, data: l.data, topics: l.topics }) } catch { return null } })
  .find(e => e?.eventName === 'BetPlaced')
eq('F1 BetPlaced.bettor == the wallet contract', bp.args.bettor, getAddress(W))
eq('F1 BetPlaced.stake == 1 USDC', bp.args.stake, STAKE)
eq('F1 wallet paid exactly stake + 2% fee', before - await bal(W), COST)
eq('F1 market is not owned by / did not pay the relay', await bal(RELAY.address), 0n)
eq('F1 USDC nonce now spent', await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'authorizationState', args: [W, nonce] }), true)

const s = summary()
process.exit(s.fail === 0 && s.stops.length === 0 ? 0 : 1)
