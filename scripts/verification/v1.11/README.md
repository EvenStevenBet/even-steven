# BaseScan verification inputs — v1.11 / v1.6 (Base mainnet)

**Not deployed yet.** These inputs are prepared ahead of the v3 deploy; the addresses
below are blank until `scripts/mainnet-deploy.mjs` runs. The v1.10/v1.5 bundle in the
parent directory is the record for the contracts that are live today — leave it alone.

`standard-json-input.json` is a solc Standard JSON Input containing all 8 sources
(3 project files + 5 OpenZeppelin 4.9.3 dependencies, keyed by the exact versioned
import strings the contracts use). Compiling it reproduces the expected runtime sizes
exactly — **19,668 / 8,085 / 18,270** — so it is known-good before submission rather
than hoped-for. It was generated and checked against those three numbers.

## Compiler settings (identical for all three)

| Setting | Value |
|---|---|
| Compiler | `v0.8.20+commit.a1b79de6` |
| Optimization | **Enabled** |
| Runs | **200** — *not 1; this changed in v3* |
| EVM Version | **shanghai** |
| License | MIT |

The runs value is the one thing that differs from every earlier release. At `runs=1`
the same sources compile to 19,439 / 8,048 / 18,022, which will not match the deployed
bytecode and will fail verification.

On BaseScan choose **Solidity (Standard-Json-Input)** and upload
`standard-json-input.json`. The settings above are already inside that file; the
dropdowns only need to match the compiler version.

## Contracts

### MarketDeployer v1.1
- Address: _(fill in after deploy)_
- Contract name: `MarketDeployer-v1_1.sol:MarketDeployer`
- Constructor arguments: **none**
- Expected runtime: 19,668 bytes

### SportsbookFactory v1.6
- Address: _(fill in after deploy)_
- Contract name: `SportsbookFactory-v1_6.sol:SportsbookFactory`
- Constructor arguments: `(address _usdc, address _oo, address _deployer)`
  - `_usdc` = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - `_oo` = `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c`
  - `_deployer` = the MarketDeployer v1.1 address
- Expected runtime: 8,085 bytes

### SportsbookMarket v1.11
- Address: _(the first market created by the factory)_
- Contract name: `SportsbookMarket-v1_11.sol:SportsbookMarket`
- Constructor arguments: `(address usdc, address oo, int256 spreadMax, int256 spreadMin,
  uint256 feePercent, bytes32 identifier, uint256 protocolSeed)` — as passed by
  MarketDeployer; take the values from the deploy transaction
- Expected runtime: 18,270 bytes

## Regenerating

If the contracts change, regenerate rather than hand-editing: the file must stay in
step with `contracts/` and with the runs value in `scripts/mainnet-deploy.mjs`.
