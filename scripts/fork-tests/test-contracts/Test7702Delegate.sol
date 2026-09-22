// SPDX-License-Identifier: MIT
// TEST-ONLY. A delegate an EIP-7702 account can point at, which DOES implement
// ERC-1271 by recovering the plain 65-byte signature and comparing it to the
// account itself. Under 7702 this code runs in the EOA's context, so address(this)
// is the delegating account.
//
// Contrast with the delegate that real hardhat-default accounts carry on Base
// mainnet, which does not answer isValidSignature usefully — with that one, USDC
// rejects every EIP-3009 authorization from the account.
pragma solidity ^0.8.20;

contract Test7702Delegate {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant BAD   = 0xffffffff;

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return BAD;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8   v = uint8(signature[64]);
        if (ecrecover(hash, v, r, s) != address(this)) return BAD;
        return MAGIC;
    }
}
