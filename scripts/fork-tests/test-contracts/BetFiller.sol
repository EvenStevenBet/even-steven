// SPDX-License-Identifier: MIT
// TEST-ONLY helper. Not part of the protocol and never deployed anywhere but the fork.
//
// D8 needs a market carrying MAX_BETS (1000) bets on BOTH the v1.10 and the v1.11
// deployment. Placing those 2000 bets as 2000 externally-owned transactions drives the
// hardhat fork into the ground (block production collapses as the chain grows), so the
// bets are placed in a handful of transactions instead: this contract holds USDC and
// loops placeBet(). Each iteration is an ordinary external call, so the market sees
// exactly what it would see from 1000 separate senders — same nonReentrant path, same
// fee sweep, same _updateZ.
pragma solidity ^0.8.20;

interface IMarketLike { function placeBet(bool greaterThan, uint256 stake) external; }
interface IERC20Like  { function approve(address spender, uint256 value) external returns (bool); }

contract BetFiller {
    function approveMarket(address usdc, address market) external {
        IERC20Like(usdc).approve(market, type(uint256).max);
    }

    /// @param startIndex index of the first bet, so side alternation continues across calls
    function fill(address market, uint256 count, uint256 stake, uint256 startIndex) external {
        for (uint256 i = 0; i < count; i++) {
            IMarketLike(market).placeBet(((startIndex + i) % 2) == 0, stake);
        }
    }
}
