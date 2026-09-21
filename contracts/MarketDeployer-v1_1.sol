// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SportsbookMarket-v1_11.sol";

/**
 * @title MarketDeployer v1.1
 * @notice Holds SportsbookMarket's creation bytecode so SportsbookFactory
 *         does not have to.
 * @dev v1.1 carries SportsbookMarket v1.11 (adds claimPayoutFor); body unchanged from v1.0.
 *
 * WHY THIS EXISTS:
 *   A contract that does `new SportsbookMarket(...)` embeds the market's entire
 *   creation code (~17.1 KB) in its own runtime bytecode. In v1.4 that left the
 *   factory at 24,153 bytes — 423 bytes under the EIP-170 24,576 limit. The
 *   v1.10 market is ~1.2 KB larger, which pushed the combined factory 837 bytes
 *   OVER the limit and made it undeployable.
 *
 *   Splitting the `new` into this contract keeps SportsbookMarket byte-identical
 *   to what is audited and deployed — same constructor, same immutables, no
 *   proxy/clone/initializer pattern and no extra storage reads on the hot path —
 *   while returning the factory to ~8.4 KB with ~16 KB of permanent headroom.
 *
 * TRUST MODEL:
 *   deploy() is permissionless. Anyone may call it, but a market produced by a
 *   direct call is never registered in the factory's marketByGameId /
 *   allMarkets, is not discoverable through any factory view, and is owned by
 *   whoever called deploy(). It is an orphan contract, not a protocol market.
 *   The factory's own address is what makes a market real.
 *
 *   This contract is immutable and stateless — it holds no funds and has no
 *   owner. The factory pins it as an immutable at construction.
 */
contract MarketDeployer {
    /**
     * @notice Deploy a SportsbookMarket and hand ownership to the caller.
     * @dev Ownership is transferred to msg.sender (the factory) so the factory
     *      can call openMarket() — which is onlyOwner — and then pass ownership
     *      on to the market creator, exactly as v1.4 did.
     */
    function deploy(
        address usdc,
        address oo,
        int256  spreadMax,
        int256  spreadMin,
        uint256 feePercent,
        bytes32 identifier,
        uint256 protocolSeed
    ) external returns (address) {
        SportsbookMarket market = new SportsbookMarket(
            usdc,
            oo,
            spreadMax,
            spreadMin,
            feePercent,
            identifier,
            protocolSeed
        );
        market.transferOwnership(msg.sender);
        return address(market);
    }
}
