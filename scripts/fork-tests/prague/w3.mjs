// W3 under REAL EIP-7702 semantics (hardfork prague). The main suite's node is
// shanghai, where 0xef0100… is simply invalid code rather than a delegation.
import fs from 'fs'; import path from 'path'; import solc from 'solc'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, keccak256, toHex,
         encodeAbiParameters, encodeFunctionData, getAddress, decodeEventLog } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { base } from 'viem/chains'

const RPC = 'http://127.0.0.1:8547'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OOV3 = '0x2aBf1Bd76655de80eDB3086114315Eec75AF500c'
const CONTRACTS = '/Users/jeff/Desktop/Action Bet/sportsbook-dapp/repo/contracts'
const TESTC     = '/Users/jeff/Desktop/Action Bet/sportsbook-dapp/repo/scripts/fork-tests/test-contracts'
const OZ        = '/tmp/hh-prague/node_modules/@openzeppelin/contracts'
const POLL = { pollingInterval: 20 }
const pub  = createPublicClient({ chain: base, transport: http(RPC, { timeout: 900000 }), ...POLL })
const test = createTestClient({ chain: base, mode: 'hardhat', transport: http(RPC, { timeout: 900000 }), ...POLL })
const wal  = a => createWalletClient({ account: a, chain: base, transport: http(RPC, { timeout: 900000 }), ...POLL })
const USD = n => BigInt(Math.round(n * 1e6))
let pass = 0, fail = 0
const ok = (l, c, d='') => { c ? (pass++, console.log('  PASS  ' + l + (d?'  — '+d:''))) : (fail++, console.log('  FAIL  ' + l + (d?'  — '+d:''))) }

function findImport(imp) {
  const m = imp.match(/^@openzeppelin\/contracts@?[\d.]*\/(.*)$/)
  for (const p of (m ? [path.join(OZ, m[1])] : [path.join(CONTRACTS, imp.replace(/^\.\//,'')), path.join(TESTC, imp.replace(/^\.\//,''))]))
    { try { return { contents: fs.readFileSync(p,'utf8') } } catch {} }
  return { error: 'not found: ' + imp }
}
function compile(files, dir, runs) {
  const sources = {}; for (const f of files) sources[f] = { content: fs.readFileSync(path.join(dir, f),'utf8') }
  const out = JSON.parse(solc.compile(JSON.stringify({ language:'Solidity', sources, settings:{
    optimizer:{enabled:true,runs}, evmVersion:'shanghai',
    outputSelection:{'*':{'*':['evm.bytecode.object','evm.deployedBytecode.object','abi']}} } }), { import: findImport }))
  const errs=(out.errors||[]).filter(e=>e.severity==='error'); if(errs.length){errs.forEach(e=>console.error(e.formattedMessage));process.exit(1)}
  const a={}; for(const fl of Object.keys(out.contracts)) for(const [n,c] of Object.entries(out.contracts[fl]))
    if(c.evm.bytecode.object) a[n]={abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,size:c.evm.deployedBytecode.object.length/2}
  return a
}
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)','function approve(address,uint256) returns (bool)',
  'function name() view returns (string)','function version() view returns (string)','function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function masterMinter() view returns (address)','function configureMinter(address,uint256) returns (bool)','function mint(address,uint256) returns (bool)'])

let minted=false
async function mintUSDC(to, amt) {
  const master = await pub.readContract({address:USDC,abi:erc20,functionName:'masterMinter'})
  await test.impersonateAccount({address:master}); await test.setBalance({address:master,value:10n**20n})
  const w = createWalletClient({account:master,chain:base,transport:http(RPC,{timeout:900000}),...POLL})
  if(!minted){ await pub.waitForTransactionReceipt({hash: await w.writeContract({address:USDC,abi:erc20,functionName:'configureMinter',args:[master,2n**128n]})}); minted=true }
  await pub.waitForTransactionReceipt({hash: await w.writeContract({address:USDC,abi:erc20,functionName:'mint',args:[to,amt]})})
  await test.stopImpersonatingAccount({address:master})
}

console.log('='.repeat(78))
console.log('W3 — EIP-7702 under REAL Prague semantics')
console.log('='.repeat(78))
console.log('solc           :', solc.version())
console.log('hardfork       : prague (hardhat ' + JSON.parse(fs.readFileSync('/tmp/hh-prague/node_modules/hardhat/package.json')).version + ')')
// One block must be mined before the first eth_call: until then EDR has no
// hardfork activation history for the forked chain and rejects every call.
await test.mine({ blocks: 1 })
console.log('fork block     :', (await pub.getBlockNumber()).toString())

const arts = compile(['SportsbookMarket-v1_11.sol','MarketDeployer-v1_1.sol','SportsbookFactory-v1_6.sol'], CONTRACTS, 200)
console.log('market runtime :', arts.SportsbookMarket.size, '(runs=200)')
const del  = compile(['Test7702Delegate.sol'], TESTC, 1)

const OWNER = privateKeyToAccount(generatePrivateKey()), RELAY = privateKeyToAccount(generatePrivateKey())
for (const a of [OWNER, RELAY]) { await test.setBalance({address:a.address,value:10n**23n}); await mintUSDC(a.address, USD(100000)) }
ok('actors are bare EOAs on the fork', (await pub.getCode({address:OWNER.address})||'0x')==='0x' && (await pub.getCode({address:RELAY.address})||'0x')==='0x')

const dep = async (n,args=[]) => { const h = await wal(OWNER).deployContract({abi:arts[n].abi,bytecode:arts[n].bytecode,args})
  return (await pub.waitForTransactionReceipt({hash:h})).contractAddress }
const deployer = await dep('MarketDeployer'), factory = await dep('SportsbookFactory',[USDC,OOV3,deployer])
const M = arts.SportsbookMarket.abi, F = arts.SportsbookFactory.abi
await pub.waitForTransactionReceipt({hash: await wal(OWNER).writeContract({address:USDC,abi:erc20,functionName:'approve',args:[factory,2n**256n-1n]})})
let seq=0
const mkMarket = async () => { const h = await wal(OWNER).writeContract({address:factory,abi:F,functionName:'createMarket',args:['NFL-2026-06-0'+(seq++)+'-HOME-P-AWAY-Q',0n,USD(1)]})
  const r = await pub.waitForTransactionReceipt({hash:h}); return '0x'+r.logs.find(l=>l.address.toLowerCase()===factory.toLowerCase()).topics[1].slice(26) }

const dh = await wal(OWNER).deployContract({abi:del.Test7702Delegate.abi,bytecode:del.Test7702Delegate.bytecode,args:[]})
const DELEGATE = (await pub.waitForTransactionReceipt({hash:dh})).contractAddress
console.log('ERC-1271 delegate deployed:', DELEGATE)

const dom = { name: await pub.readContract({address:USDC,abi:erc20,functionName:'name'}),
              version: await pub.readContract({address:USDC,abi:erc20,functionName:'version'}),
              chainId: 8453, verifyingContract: USDC }
const TYPES = { ReceiveWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}] }
const derived = (salt, gt) => keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bool'}],[salt,gt]))
const STAKE = USD(100), COST = STAKE + STAKE*200n/10000n

async function attempt(label, account, fn, saltStr) {
  const market = await mkMarket()
  const salt = keccak256(toHex(saltStr)), nonce = derived(salt, true)
  const vb = (await pub.getBlock()).timestamp + 3600n
  const sig = await account.signTypedData({ domain: dom, types: TYPES, primaryType:'ReceiveWithAuthorization',
    message:{ from: account.address, to: market, value: COST, validAfter:0n, validBefore: vb, nonce } })
  const args = fn === 'placeBetForWithSignature'
    ? [account.address, true, STAKE, { validAfter:0n, validBefore:vb, nonce, salt, signature: sig }]
    : [account.address, true, STAKE, { validAfter:0n, validBefore:vb, nonce, salt,
        v: Number('0x'+sig.slice(130,132)), r:'0x'+sig.slice(2,66), s:'0x'+sig.slice(66,130) }]
  const data = encodeFunctionData({ abi:M, functionName: fn, args })
  const res = await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{from:RELAY.address,to:market,data},'latest']})})
  const j = await res.json()
  if (j.error) {
    const d = j.error.data; const raw = typeof d==='string'?d:(d&&d.data)||null
    let dec=''
    if (raw && String(raw).startsWith('0x08c379a0')) { const h=String(raw); const len=parseInt(h.slice(2+8+64,2+8+128),16)
      dec = ' Error("'+Buffer.from(h.slice(2+8+128,2+8+128+len*2),'hex').toString('utf8')+'")' }
    console.log('  ' + label + ' -> REVERT  raw=' + raw + dec)
    return { ok:false, raw }
  }
  const h = await wal(RELAY).writeContract({ address: market, abi: M, functionName: fn, args })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  const bp = r.logs.filter(l=>l.address.toLowerCase()===market.toLowerCase())
    .map(l=>{try{return decodeEventLog({abi:M,data:l.data,topics:l.topics})}catch{return null}}).find(e=>e&&e.eventName==='BetPlaced')
  console.log('  ' + label + ' -> SUCCESS  gas=' + r.gasUsed + '  BetPlaced.bettor=' + bp.args.bettor)
  return { ok:true, gas:r.gasUsed, bettor: bp.args.bettor }
}

// --- the account, delegated to a delegate that DOES implement ERC-1271 ---
const acc = privateKeyToAccount(generatePrivateKey())
await mintUSDC(acc.address, COST*3n)
const CODE = '0xef0100' + DELEGATE.slice(2).toLowerCase()
await test.setCode({ address: acc.address, bytecode: CODE })
console.log('\ndelegated account :', acc.address)
console.log('delegation code   :', CODE)
console.log('DELEGATION PREFIX :', '0xef0100')
ok('account carries the 7702 delegation', (await pub.getCode({address:acc.address})) === CODE, CODE)
ok('account ETH == 0', (await pub.getBalance({address:acc.address})) === 0n)

// Prove the delegation actually RESOLVES under prague: call isValidSignature on the
// account itself and check the delegate's code answered.
{
  const probeHash = keccak256(toHex('probe'))
  const psig = await acc.sign({ hash: probeHash })
  const data = encodeFunctionData({ abi: del.Test7702Delegate.abi, functionName:'isValidSignature', args:[probeHash, psig] })
  const res = await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:acc.address,data},'latest']})})
  const j = await res.json()
  console.log('\n  isValidSignature() called ON THE ACCOUNT ->', j.result ?? JSON.stringify(j.error))
  ok('7702 delegation resolves: the account answers ERC-1271 with the magic value',
     (j.result||'').startsWith('0x1626ba7e'), String(j.result).slice(0,10))
}

console.log('\n--- W3(a) placeBetForWithSignature ---')
const a = await attempt('W3(a)', acc, 'placeBetForWithSignature', 'p-a')
ok('W3(a) placeBetForWithSignature succeeds for a 7702 account with an ERC-1271 delegate', a.ok)
if (a.ok) ok('W3(a) BetPlaced.bettor == the delegated account', getAddress(a.bettor) === getAddress(acc.address), a.bettor)

console.log('\n--- W3(b) placeBetFor (65-byte compatible) ---')
const b = await attempt('W3(b)', acc, 'placeBetFor', 'p-b')
ok('W3(b) placeBetFor ALSO succeeds for the same account', b.ok)
if (b.ok) ok('W3(b) BetPlaced.bettor == the delegated account', getAddress(b.bettor) === getAddress(acc.address), b.bettor)

console.log('\n--- W3(c) negative control: the delegate real hardhat-default accounts carry on Base mainnet ---')
const acc2 = privateKeyToAccount(generatePrivateKey())
await mintUSDC(acc2.address, COST*2n)
const BAD = '0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a'
await test.setCode({ address: acc2.address, bytecode: BAD })
console.log('  delegation code   :', BAD)
console.log('  delegate has code :', ((await pub.getCode({address:'0x8a67b5020ee254ef48e3b6a04927f39baf7e408a'}))||'0x').length > 2)
const c1 = await attempt('W3(c) placeBetForWithSignature', acc2, 'placeBetForWithSignature', 'p-c1')
const c2 = await attempt('W3(c) placeBetFor', acc2, 'placeBetFor', 'p-c2')
ok('W3(c) placeBetForWithSignature rejected for that delegate', !c1.ok, String(c1.raw).slice(0,10))
ok('W3(c) placeBetFor rejected for that delegate', !c2.ok, String(c2.raw).slice(0,10))

console.log('\n' + '='.repeat(78))
console.log('W3 SUMMARY: ' + pass + ' passed, ' + fail + ' failed')
console.log('='.repeat(78))
process.exit(fail === 0 ? 0 : 1)
