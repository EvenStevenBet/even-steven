// EIP-7702 control experiment.
//
// Claim under test: a bettor address carrying an EIP-7702 delegation cannot use
// placeBetFor, because Circle's FiatTokenV2_2 routes signature checking through
// SignatureChecker, which treats any address WITH CODE as a contract signer and
// takes the EIP-1271 path instead of ecrecover.
//
// Method: the SAME fresh key is used twice. First as a bare EOA -> placeBetFor
// succeeds. Then hardhat_setCode writes a 7702 delegation indicator to that exact
// address and the identical flow is repeated. Nothing in the contracts changes.
import { compileSet, V111, assertSolc } from './lib/compile.mjs'
import { pub, test, wallet, acct, mintUSDC, setBalanceEth, assertFreshActors, USDC, erc20Abi,
         signAuthorization, rawCall } from './lib/chain.mjs'
import { deployVersionSet, approveMax, createMarket } from './lib/deploy.mjs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex, encodeFunctionData } from 'viem'

const RUNS = Number(process.env.RUNS || 200)
const USD = n => BigInt(Math.round(n * 1e6))

// The 7702 delegation indicator is 0xef0100 || <20-byte delegate address>.
// The delegate used here is the one actually observed on hardhat's default
// accounts at this fork block, so the shape matches real Base mainnet state.
const DELEGATION_PREFIX = '0xef0100'
const DELEGATE          = '8a67b5020ee254ef48e3b6a04927f39baf7e408a'
const DELEGATION_CODE   = DELEGATION_PREFIX + DELEGATE

await assertFreshActors(3)
const [OWNER, RELAY, BOB] = [0, 1, 2].map(acct)
for (const a of [OWNER, RELAY, BOB]) { await setBalanceEth(a.address, 10n ** 23n); await mintUSDC(a.address, USD(100000)) }

const arts = compileSet(V111, RUNS)
const set  = await deployVersionSet(arts, OWNER)
const ABI  = arts.SportsbookMarket.abi
await approveMax(OWNER, set.factory)

const bettor = privateKeyToAccount(generatePrivateKey())
await mintUSDC(bettor.address, USD(1000))

console.log('='.repeat(78))
console.log('EIP-7702 CONTROL — v1.11 @ runs=' + RUNS + ', solc ' + assertSolc())
console.log('fork block', (await pub.getBlockNumber()).toString())
console.log('='.repeat(78))
console.log('bettor (fresh key)     :', bettor.address)
console.log('bettor ETH             :', (await pub.getBalance({ address: bettor.address })).toString())
console.log('bettor USDC            :', (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [bettor.address] })).toString())

const stake = USD(100), fee = stake * 200n / 10000n
async function attempt(label, salt) {
  const gid = `NFL-2026-04-01-HOME-Chiefs-AWAY-49ers-7702-${salt}`
  const { market } = await createMarket(set, OWNER, gid, 0n, USD(1))
  const auth = await signAuthorization({ signer: bettor, market, value: stake + fee,
                                         salt: keccak256(toHex(salt)), greaterThan: true })
  const pack = { validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce,
                 salt: auth.salt, v: auth.v, r: auth.r, s: auth.s }
  const data = encodeFunctionData({ abi: ABI, functionName: 'placeBetFor',
                                    args: [bettor.address, true, stake, pack] })
  const code = await pub.getCode({ address: bettor.address })
  console.log(`\n--- ${label} ---`)
  console.log('  bettor code            :', code && code !== '0x' ? code : '0x  (bare EOA)')
  console.log('  code length (bytes)    :', code && code !== '0x' ? (code.length - 2) / 2 : 0)
  const call = await rawCall({ from: RELAY.address, to: market, data })
  if (call.ok) {
    const h = await wallet(RELAY).writeContract({ address: market, abi: ABI, functionName: 'placeBetFor',
                                                  args: [bettor.address, true, stake, pack] })
    const r = await pub.waitForTransactionReceipt({ hash: h })
    console.log('  eth_call               : OK')
    console.log('  transaction            :', r.status, ' gas', r.gasUsed.toString())
    console.log('  RESULT                 : SUCCESS')
  } else {
    console.log('  eth_call               : REVERTED')
    console.log('  RAW REVERT DATA        :', call.data)
    if (String(call.data).startsWith('0x08c379a0')) {
      const h = String(call.data)
      const len = parseInt(h.slice(2 + 8 + 64, 2 + 8 + 128), 16)
      const str = Buffer.from(h.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString('utf8')
      console.log('  DECODED                : Error("' + str + '")')
    }
    console.log('  node message           :', call.message)
    console.log('  RESULT                 : REVERTED')
  }
  return call.ok
}

const before = await attempt('STEP 1 — bare EOA (no delegation)', 'seven-a')

await test.setCode({ address: bettor.address, bytecode: DELEGATION_CODE })
console.log('\n  hardhat_setCode applied to', bettor.address)
console.log('  DELEGATION PREFIX USED :', DELEGATION_PREFIX)
console.log('  DELEGATE ADDRESS       : 0x' + DELEGATE)
console.log('  FULL CODE WRITTEN      :', DELEGATION_CODE)

const after = await attempt('STEP 2 — same key, 7702 delegation present', 'seven-b')

console.log('\n' + '='.repeat(78))
console.log('CONTROL RESULT: bare EOA =', before ? 'SUCCESS' : 'REVERT',
            '| delegated =', after ? 'SUCCESS' : 'REVERT')
console.log(before && !after
  ? 'Delegation alone flips placeBetFor from success to revert. Contracts unchanged.'
  : '*** UNEXPECTED — investigate ***')
console.log('='.repeat(78))
