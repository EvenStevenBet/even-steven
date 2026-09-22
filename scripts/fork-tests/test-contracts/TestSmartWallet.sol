// SPDX-License-Identifier: MIT
// TEST-ONLY. Not part of the protocol; never deployed anywhere but a fork/testnet.
//
// A minimal ERC-1271 wallet whose signature envelope is deliberately NOT 65-byte
// ECDSA: it is abi.encode(uint256 ownerIndex, bytes ecdsaSig), which mirrors the
// shape Coinbase Smart Wallet uses. That is the whole point of the test — such a
// signature cannot be expressed as (v, r, s), so it can only reach USDC through
// placeBetForWithSignature.
pragma solidity ^0.8.20;

contract TestSmartWallet {
    address public owner;

    /// 0 = behave correctly, 1 = return the wrong magic value, 2 = revert outright.
    uint8 public mode;

    bytes4 private constant MAGIC = 0x1626ba7e;   // ERC-1271 isValidSignature selector
    bytes4 private constant BAD   = 0xffffffff;

    constructor(address _owner, uint8 _mode) { owner = _owner; mode = _mode; }

    function setMode(uint8 _mode) external { mode = _mode; }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (mode == 2) revert("TestSmartWallet: deliberate revert");

        // The envelope: abi.encode(ownerIndex, ecdsaSig). A 65-byte ECDSA blob does
        // not decode as this, which is exactly why placeBetFor cannot carry it.
        (uint256 ownerIndex, bytes memory sig) = abi.decode(signature, (uint256, bytes));
        if (ownerIndex != 0) return BAD;
        if (sig.length != 65) return BAD;

        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (ecrecover(hash, v, r, s) != owner) return BAD;
        return mode == 1 ? BAD : MAGIC;
    }
}
