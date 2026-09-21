// Compiles the v1.10 and v1.11 contract sets at the PINNED production settings.
// The bytecode these tests deploy is byte-for-byte the bytecode that would be
// deployed to mainnet — nothing is recompiled by hardhat.
import fs from 'fs'
import path from 'path'
import url from 'url'
import solc from 'solc'

const HERE      = path.dirname(url.fileURLToPath(import.meta.url))
export const CONTRACTS = path.resolve(HERE, '../../../contracts')
const OZ_ROOT   = path.resolve(HERE, '../node_modules/@openzeppelin/contracts')

export const SOLC_EXPECTED = '0.8.20+commit.a1b79de6'

export const V110 = { market: 'SportsbookMarket-v1_10.sol', deployer: 'MarketDeployer-v1_0.sol', factory: 'SportsbookFactory-v1_5.sol' }
export const V111 = { market: 'SportsbookMarket-v1_11.sol', deployer: 'MarketDeployer-v1_1.sol', factory: 'SportsbookFactory-v1_6.sol' }

function findImport(imp) {
  const m = imp.match(/^@openzeppelin\/contracts@?[\d.]*\/(.*)$/)
  const p = m ? path.join(OZ_ROOT, m[1]) : path.join(CONTRACTS, imp.replace(/^\.\//, ''))
  try { return { contents: fs.readFileSync(p, 'utf8') } } catch (e) { return { error: 'not found: ' + imp } }
}

/** Compile a TEST-ONLY helper that lives in scripts/fork-tests/test-contracts. */
export function compileTestContract(file, name) {
  assertSolc()
  const src = path.resolve(HERE, '../test-contracts', file)
  const input = { language: 'Solidity', sources: { [file]: { content: fs.readFileSync(src, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } } } }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))
  const errs = (out.errors || []).filter(e => e.severity === 'error')
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); throw new Error('compile failed') }
  const c = out.contracts[file][name]
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
}

export function assertSolc() {
  if (!solc.version().startsWith(SOLC_EXPECTED))
    throw new Error(`solc is ${solc.version()}, expected ${SOLC_EXPECTED}. Refusing to measure.`)
  return solc.version()
}

/** Compile one version set. `runs` defaults to the production value of 1. */
export function compileSet(set, runs = 1) {
  assertSolc()
  const files = [set.market, set.deployer, set.factory]
  const sources = {}
  for (const f of files) sources[f] = { content: fs.readFileSync(path.join(CONTRACTS, f), 'utf8') }
  // Mutation testing: MUTANT_SRC swaps in a modified copy of the v1.11 market from
  // outside the repo, so a mutant is never written into contracts/ and can never be
  // committed. Only ever applied to the v1.11 market.
  if (process.env.MUTANT_SRC && set.market === V111.market) {
    sources[set.market] = { content: fs.readFileSync(process.env.MUTANT_SRC, 'utf8') }
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } },
    },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }))
  const errs = (out.errors || []).filter(e => e.severity === 'error')
  if (errs.length) { errs.forEach(e => console.error(e.formattedMessage)); throw new Error('compile failed') }
  const warnings = (out.errors || []).filter(e => e.severity !== 'error')
  const arts = { warnings, runs, solc: solc.version() }
  for (const fl of Object.keys(out.contracts))
    for (const [n, c] of Object.entries(out.contracts[fl]))
      if (c.evm.bytecode.object) arts[n] = {
        abi: c.abi,
        bytecode: '0x' + c.evm.bytecode.object,
        runtimeSize: c.evm.deployedBytecode.object.length / 2,
        creationSize: c.evm.bytecode.object.length / 2,
      }
  return arts
}
