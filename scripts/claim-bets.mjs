import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, getAddress, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import dotenv from 'dotenv'
const HERE = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(HERE, '.env') })
const MKT='0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9'
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RPC=process.env.MAINNET_RPC||'https://base.drpc.org'
const f=v=>formatUnits(v,6)
const die=m=>{console.error('\n*** ABORT: '+m);process.exit(1)}
process.on('unhandledRejection',e=>die((e.shortMessage||e.message||'')+(e.details?' | '+e.details:'')))
const pub=createPublicClient({chain:base,transport:http(RPC,{timeout:120000})})
const M=parseAbi([
 'function getBet(uint256) view returns ((address bettor,uint256 stake,bool greaterThan,int256 lockedZ,bool claimed))',
 'function getBetsByAddress(address) view returns (uint256[])',
 'function claimPayouts(uint256[] betIds)','function settled() view returns (bool)',
 'function totalPool() view returns (uint256)','function protocolSeedTotal() view returns (uint256)',
 'function cachedWinningStakes() view returns (uint256)','function finalSpread() view returns (int256)',
 'event PayoutClaimed(address indexed bettor, uint256 amount)'])
const E=parseAbi(['function balanceOf(address) view returns (uint256)'])

const k=(process.env.SEPOLIA_PRIVATE_KEY||'').trim()
if(!k) die('no key in .env')
const acct=privateKeyToAccount(k)
console.log('claiming as:',acct.address)
if(getAddress(acct.address)!=='0x1164a458a716289c3d724fd1b3A8F5072593271e') die('unexpected address')
const w=createWalletClient({account:acct,chain:base,transport:http(RPC,{timeout:120000})})
const r=(fn,args)=>pub.readContract({address:MKT,abi:M,functionName:fn,args})

if(!(await r('settled'))) die('market not settled')
const fs_=await r('finalSpread'), tP=await r('totalPool'), sT=await r('protocolSeedTotal'), cw=await r('cachedWinningStakes')
console.log('finalSpread:',fs_.toString(),' distributable:',f(tP-sT),' winningStakes:',f(cw))

const ids=await r('getBetsByAddress',[acct.address])
const winners=[]
for(const id of ids){
  const b=await r('getBet',[id])
  const scaled=fs_*10000n
  const win=b.greaterThan? scaled>b.lockedZ : scaled<=b.lockedZ
  const payout=win&&cw>0n?(b.stake*(tP-sT))/cw:0n
  console.log('  betId',id.toString(),'|',b.greaterThan?'GREATER   ':'LESS/EQUAL','| stake',f(b.stake),
    '| lockedZ',b.lockedZ.toString().padStart(7),'|',win?'WIN  payout '+f(payout):'LOSE','| claimed',b.claimed)
  if(win&&!b.claimed) winners.push(id)
}
if(!winners.length) die('nothing to claim')
console.log('\nclaiming betIds ['+winners.join(',')+'] via claimPayouts (v1.10 batch)')
if(!process.argv.includes('--confirm')) die('refusing without --confirm')

const before=await pub.readContract({address:USDC,abi:E,functionName:'balanceOf',args:[acct.address]})
const h=await w.writeContract({address:MKT,abi:M,functionName:'claimPayouts',args:[winners]})
console.log('claimPayouts tx:',h)
const rc=await pub.waitForTransactionReceipt({hash:h})
if(rc.status!=='success') die('claimPayouts reverted')
const pc=parseEventLogs({abi:M,logs:rc.logs}).find(l=>l.eventName==='PayoutClaimed')
const B=rc.blockNumber
const bal=b=>pub.readContract({address:USDC,abi:E,functionName:'balanceOf',args:[acct.address],blockNumber:b})
const got=(await bal(B))-(await bal(B-1n))
console.log('  status:',rc.status,' block:',B,' gas:',rc.gasUsed)
console.log('  PayoutClaimed(bettor='+pc.args.bettor+', amount='+f(pc.args.amount)+')')
console.log('  wallet USDC delta @'+(B-1n)+'->'+B+' : +'+f(got))
console.log('  market USDC after  :',f(await pub.readContract({address:USDC,abi:E,functionName:'balanceOf',args:[MKT],blockNumber:B})))
for(const id of ids){ const b=await r('getBet',[id]); console.log('  betId',id.toString(),'claimed:',b.claimed) }
