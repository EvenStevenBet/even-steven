# BaseScan verification inputs — v1.10 / v1.5 (Base mainnet)

> This bundle is the record for the contracts **live on Base mainnet today**, compiled at
> `runs=1`. Do not change it. The v3 release (v1.11 / v1.6, `runs=200`) has its own bundle
> in [`v1.11/`](v1.11/).

Everything needed to verify all three contracts. Not submitted from this machine:
no `ETHERSCAN_API_KEY` exists in the project, so this must be done through the
BaseScan UI or with a key supplied separately. (BaseScan verification now runs
through Etherscan's unified multichain API/key system — the env var is
`ETHERSCAN_API_KEY`, not `BASESCAN_API_KEY`, even though submission is still to
BaseScan for a Base contract.)

`standard-json-input.json` is a solc Standard JSON Input containing all 8 sources
(3 project files + 5 OpenZeppelin 4.9.3 dependencies, keyed by the exact
versioned import strings the contracts use). Compiling that file reproduces the
deployed runtime sizes exactly — 17,650 / 8,048 / 16,254 — so it is known-good
before submission rather than hoped-for.

## Compiler settings (identical for all three)

| Setting | Value |
|---|---|
| Compiler | `v0.8.20+commit.a1b79de6` |
| Optimization | **Enabled** |
| Runs | **1** |
| EVM Version | **shanghai** |
| License | MIT |

On BaseScan choose **Solidity (Standard-Json-Input)** and upload
`standard-json-input.json`. The settings above are already inside that file; the
dropdowns only need to match the compiler version.

## Contracts

### MarketDeployer v1.0
- Address: `0xa88b73cff7187f84f5615e396c5bf34daeea1d70`
- Contract name: `MarketDeployer-v1_0.sol:MarketDeployer`
- Constructor arguments: **none**

### SportsbookFactory v1.5
- Address: `0xf69d4c986bb9fa8177e74b8cb9e2c49f4200adbd`
- Contract name: `SportsbookFactory-v1_5.sol:SportsbookFactory`
- Constructor: `(address _usdc, address _oo, address _deployer)`
  = USDC, UMA OOv3, MarketDeployer
- ABI-encoded constructor arguments:

```
000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000002abf1bd76655de80edb3086114315eec75af500c000000000000000000000000a88b73cff7187f84f5615e396c5bf34daeea1d70
```

### SportsbookMarket v1.10
- Address: `0x05170a958B4a1F70Fd8c6495F650475bCcbE43e9` (Bills/Lions)
- Contract name: `SportsbookMarket-v1_10.sol:SportsbookMarket`
- Constructor: `(address _usdc, address _oo, int256 _spreadMax, int256 _spreadMin,
  uint256 _feePercent, bytes32 _identifier, uint256 _protocolSeed)`
  = USDC, OOv3, 100, -100, 200, `ASSERT_TRUTH2`, 1000000
- Values taken from the `MarketCreated` event decode plus the factory's own
  constants; `_identifier` and `_protocolSeed` are read back from the deployed
  market as `ASSERTION_IDENTIFIER()` and `PROTOCOL_SEED()`.
- ABI-encoded constructor arguments:

```
000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000002abf1bd76655de80edb3086114315eec75af500c0000000000000000000000000000000000000000000000000000000000000064ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c00000000000000000000000000000000000000000000000000000000000000c84153534552545f5452555448320000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4240
```

Note `spreadMin` is `-100` in two's complement (`ffff…ff9c`) — that is correct,
not a corrupted value.

## Once verified

Markets deployed by this factory in future are all instances of the same
`SportsbookMarket` bytecode, so BaseScan should offer "Similar Match" verification
for each new market automatically once the first one above is verified.
