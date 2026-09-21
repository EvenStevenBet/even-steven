// Deploys a complete version set (MarketDeployer -> SportsbookFactory) from the
// exact solc artifacts, and creates markets through the factory.
import { pub, wallet, USDC, OOV3, erc20Abi } from './chain.mjs'

const MAX_UINT = (1n << 256n) - 1n

export async function deployVersionSet(arts, ownerAccount) {
  const w = wallet(ownerAccount)
  const dh = await w.deployContract({ abi: arts.MarketDeployer.abi, bytecode: arts.MarketDeployer.bytecode, args: [] })
  const dr = await pub.waitForTransactionReceipt({ hash: dh })
  const deployer = dr.contractAddress

  const fh = await w.deployContract({ abi: arts.SportsbookFactory.abi, bytecode: arts.SportsbookFactory.bytecode,
                                      args: [USDC, OOV3, deployer] })
  const fr = await pub.waitForTransactionReceipt({ hash: fh })
  const factory = fr.contractAddress

  const pinned = await pub.readContract({ address: factory, abi: arts.SportsbookFactory.abi, functionName: 'deployer' })
  if (pinned.toLowerCase() !== deployer.toLowerCase())
    throw new Error(`factory.deployer() ${pinned} != deployed MarketDeployer ${deployer}`)

  const onchainRuntime = async a => ((await pub.getCode({ address: a })).length - 2) / 2
  return {
    deployer, factory, abi: arts,
    sizes: {
      MarketDeployer:    await onchainRuntime(deployer),
      SportsbookFactory: await onchainRuntime(factory),
    },
    deployTx: { deployer: dh, factory: fh },
  }
}

export async function approveMax(account, spender) {
  const w = wallet(account)
  const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [spender, MAX_UINT] })
  await pub.waitForTransactionReceipt({ hash: h })
}

export async function createMarket(set, ownerAccount, gameId, oracleZ, seed) {
  const w = wallet(ownerAccount)
  const h = await w.writeContract({ address: set.factory, abi: set.abi.SportsbookFactory.abi,
                                    functionName: 'createMarket', args: [gameId, oracleZ, seed] })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  const log = r.logs.find(l => l.address.toLowerCase() === set.factory.toLowerCase())
  const market = '0x' + log.topics[1].slice(26)
  return { market, hash: h, receipt: r }
}
