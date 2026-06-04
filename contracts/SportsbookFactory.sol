// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@4.9.3/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts@4.9.3/access/Ownable.sol";
import "./SportsbookMarket-v1_8_1.sol";

error InvalidUSDCAddress();
error InvalidOOAddress();
error NotAuthorized();
error FeeBelowMinimum();
error FeeExceedsMaximum();
error GameIdRequired();
error MarketAlreadyExists();
error SeedPullFailed();
error ApprovalFailed();

/**
 * @title SportsbookFactory v1.3 (pairs with SportsbookMarket v1.8.1)
 * @notice Deploys and tracks SportsbookMarket contracts.
 *
 * WHAT'S NEW IN v1.2:
 *   - defaultFeePercent: owner-settable fee in basis points, passed to each
 *     market at creation. Launch default: 200 (2%).
 *     Agents comparison-shop in milliseconds - start competitive, stay competitive.
 *     Adjust down toward 100 (1%) if Polymarket/Kalshi undercut us on volume markets.
 *   - setDefaultFee(): owner can update fee for all future markets without redeploying.
 *     Existing markets are unaffected - fee is locked at creation time per market.
 *   - H-3 FIX: transferFrom return value checked; reverts with a custom error.
 *   - Max USDC approval for Circle USDC compatibility.
 *     Circle's USDC on Base Sepolia rejects exact-amount approvals in some cases.
 *     Using type(uint256).max avoids this. Factory approves max then market pulls
 *     exactly what it needs.
 *   - MarketCreated event now includes feePercent.
 *   - getMarketInfo() now returns feePercent.
 *
 * CARRIED FROM v1.1:
 *   - Constructor takes _oo (UMA OptimisticOracleV3 address)
 *   - createMarket() standard +-100 spread bounds
 *   - createMarketWithBounds() custom spread bounds for esports etc.
 *   - Owner or whitelisted operators can create markets
 *   - addOperator() / removeOperator() for future agent market creation
 *   - getOpenMarkets(), getUnsettledMarkets(), getRefundableMarkets()
 *   - getMarketInfo(), getAllMarkets()
 *
 * MAINNET TODO:
 *   - Add pagination to view functions (M-1) at ~500+ markets
 *   - Add per-market fee override in createMarketWithBoundsAndFee()
 *   - Wire operator authentication to MoltBook identity
 */
contract SportsbookFactory is Ownable {

    // ─────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────

    address public immutable usdc;
    address public immutable oo;   // UMA OptimisticOracleV3

    // Default spread bounds for standard sports (whole integers)
    int256 public constant DEFAULT_SPREAD_MAX =  100;
    int256 public constant DEFAULT_SPREAD_MIN = -100;

    // Fee in basis points applied to all new markets.
    // 200 = 2.00%. Max 1000 = 10%.
    // Agents see this fee via getMarketInfo() before betting.
    // Only affects future markets - existing markets keep their creation-time fee.
    uint256 public defaultFeePercent = 200;
    uint256 public constant MAX_FEE  = 1000; // 10% hard cap
    uint256 public constant MIN_FEE  = 20;   // 0.2% floor

    // All markets ever created
    address[] public allMarkets;

    // gameId to market address
    mapping(string => address) public marketByGameId;

    // market address to gameId (reverse lookup)
    mapping(address => string) public gameIdByMarket;

    // Whitelisted operators who can create markets (future agent access)
    mapping(address => bool) public operators;

    // ─────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────

    event MarketCreated(
        address indexed market,
        string  gameId,
        int256  oracleZ,
        int256  spreadMax,
        int256  spreadMin,
        uint256 feePercent,
        address indexed creator
    );
    event DefaultFeeUpdated(uint256 oldFee, uint256 newFee);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);

    // ─────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────

    /**
     * @param _usdc USDC token address
     *              Base Sepolia (Circle): 0x036cbd53842c5426634e7929541ec2318f3dcf7e
     * @param _oo   UMA OptimisticOracleV3 address
     *              Base Sepolia (confirmed): 0x0F7fC5E6482f096380db6158f978167b57388deE
     *              Base Mainnet: check https://docs.uma.xyz/resources/network-addresses
     */
    constructor(address _usdc, address _oo) {
        if (_usdc == address(0)) revert InvalidUSDCAddress();
        if (_oo   == address(0)) revert InvalidOOAddress();
        usdc = _usdc;
        oo   = _oo;
    }

    // ─────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────

    modifier onlyOperatorOrOwner() {
        if (msg.sender != owner() && !operators[msg.sender]) revert NotAuthorized();
        _;
    }

    // ─────────────────────────────────────────────
    // FEE MANAGEMENT
    // ─────────────────────────────────────────────

    /**
     * @notice Update the default fee for all future markets.
     *         Does NOT affect existing deployed markets.
     *         Agents checking getMarketInfo() will see the fee locked at
     *         the time each market was created.
     *
     * @param newFeePercent Fee in basis points. 200 = 2%, 100 = 1%, max 1000 = 10%.
     */
    function setDefaultFee(uint256 newFeePercent) external onlyOwner {
        if (newFeePercent < MIN_FEE) revert FeeBelowMinimum();
        if (newFeePercent > MAX_FEE) revert FeeExceedsMaximum();
        uint256 oldFee = defaultFeePercent;
        defaultFeePercent = newFeePercent;
        emit DefaultFeeUpdated(oldFee, newFeePercent);
    }

    // ─────────────────────────────────────────────
    // CREATE MARKET
    // ─────────────────────────────────────────────

    /**
     * @notice Deploys a new SportsbookMarket with standard +-100 spread bounds
     *         and the current defaultFeePercent.
     *
     * @param gameId   Format: "SPORT-YEAR-HOME-TeamName-AWAY-TeamName"
     *                 e.g. "NFL-2026-HOME-Chiefs-AWAY-49ers"
     * @param oracleZ  Opening line (4-decimal fixed-point), e.g. -35000 = -3.5
     *
     * Caller must approve this factory for type(uint256).max USDC before calling.
     * (Circle USDC on Base requires max approval - exact amounts fail intermittently.)
     */
    function createMarket(
        string calldata gameId,
        int256 oracleZ
    ) external onlyOperatorOrOwner returns (address) {
        return _createMarket(gameId, oracleZ, DEFAULT_SPREAD_MAX, DEFAULT_SPREAD_MIN, defaultFeePercent);
    }

    /**
     * @notice Deploys a new SportsbookMarket with custom spread bounds.
     *         Use for esports, high-scoring sports, or non-standard markets.
     *
     * @param gameId     Format: "SPORT-YEAR-HOME-TeamName-AWAY-TeamName"
     * @param oracleZ    Opening line (4-decimal fixed-point)
     * @param spreadMax  Max final spread as whole integer, e.g. 1000 for esports
     * @param spreadMin  Min final spread as whole integer, e.g. -1000 for esports
     */
    function createMarketWithBounds(
        string calldata gameId,
        int256 oracleZ,
        int256 spreadMax,
        int256 spreadMin
    ) external onlyOperatorOrOwner returns (address) {
        return _createMarket(gameId, oracleZ, spreadMax, spreadMin, defaultFeePercent);
    }

    // ─────────────────────────────────────────────
    // OPERATOR MANAGEMENT
    // ─────────────────────────────────────────────

    /**
     * @notice Whitelist an address to create markets.
     *         Future: wire to MoltBook identity for trusted agent market creation.
     */
    function addOperator(address operator) external onlyOwner {
        operators[operator] = true;
        emit OperatorAdded(operator);
    }

    function removeOperator(address operator) external onlyOwner {
        operators[operator] = false;
        emit OperatorRemoved(operator);
    }

    // ─────────────────────────────────────────────
    // VIEW FUNCTIONS - agent query layer
    // ─────────────────────────────────────────────

    /**
     * @notice Returns addresses of all currently open markets.
     *         Agents: call this first to discover betting opportunities.
     */
    function getOpenMarkets() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            if (SportsbookMarket(allMarkets[i]).bettingOpen()) count++;
        }
        address[] memory open = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            if (SportsbookMarket(allMarkets[i]).bettingOpen()) {
                open[index++] = allMarkets[i];
            }
        }
        return open;
    }

    /**
     * @notice Returns all unsettled markets (open or closed, not yet settled).
     *         Agents: find markets that need requestSettlement() calls.
     */
    function getUnsettledMarkets() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            SportsbookMarket m = SportsbookMarket(allMarkets[i]);
            if (!m.settled() && !m.canceled()) count++;
        }
        address[] memory unsettled = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            SportsbookMarket m = SportsbookMarket(allMarkets[i]);
            if (!m.settled() && !m.canceled()) {
                unsettled[index++] = allMarkets[i];
            }
        }
        return unsettled;
    }

    /**
     * @notice Returns markets where triggerRefund() is available.
     *         Agents: monitor this to protect bettors from abandoned markets.
     */
    function getRefundableMarkets() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            if (SportsbookMarket(allMarkets[i]).canTriggerRefund()) count++;
        }
        address[] memory refundable = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < allMarkets.length; i++) {
            if (SportsbookMarket(allMarkets[i]).canTriggerRefund()) {
                refundable[index++] = allMarkets[i];
            }
        }
        return refundable;
    }

    /**
     * @notice Returns all markets ever created.
     */
    function getAllMarkets() external view returns (address[] memory) {
        return allMarkets;
    }

    /**
     * @notice Total number of markets ever created.
     */
    function getMarketCount() external view returns (uint256) {
        return allMarkets.length;
    }

    /**
     * @notice Full snapshot of a market in one call.
     *         Agents: use after finding a market via getOpenMarkets() or the marketByGameId mapping.
     *         feePercent: locked at market creation time, in basis points (200 = 2%).
     */
    function getMarketInfo(address market) external view returns (
        string memory gameId,
        bool    isOpen,
        bool    isSettled,
        bool    isCanceled,
        int256  currentZ,
        uint256 totalPool,
        int256  spreadMax,
        int256  spreadMin,
        uint256 feePercent,
        bool    refundAvailable
    ) {
        SportsbookMarket m = SportsbookMarket(market);
        return (
            m.gameId(),
            m.bettingOpen(),
            m.settled(),
            m.canceled(),
            m.currentZ(),
            m.totalPool(),
            m.SPREAD_MAX(),
            m.SPREAD_MIN(),
            m.FEE_PERCENT(),
            m.canTriggerRefund()
        );
    }

    // ─────────────────────────────────────────────
    // INTERNAL: CREATE MARKET
    // ─────────────────────────────────────────────

    function _createMarket(
        string calldata gameId,
        int256 oracleZ,
        int256 spreadMax,
        int256 spreadMin,
        uint256 feePercent
    ) internal returns (address) {
        if (bytes(gameId).length == 0) revert GameIdRequired();
        if (marketByGameId[gameId] != address(0)) revert MarketAlreadyExists();

        // Deploy new market — fee locked at creation time
        SportsbookMarket market = new SportsbookMarket(
            usdc,
            oo,
            spreadMax,
            spreadMin,
            feePercent
        );

        // H-3 FIX: transferFrom return value checked (custom error)
        uint256 seedAmount = market.PROTOCOL_SEED() * 2;
        if (!IERC20(usdc).transferFrom(msg.sender, address(this), seedAmount)) revert SeedPullFailed();

        // Use max approval — Circle USDC on Base rejects exact-amount approvals
        if (!IERC20(usdc).approve(address(market), type(uint256).max)) revert ApprovalFailed();
        market.openMarket(gameId, oracleZ);

        // NEW-1 FIX: Reset approval after seed pull to prevent dangling unlimited
        // approval over factory balance. If USDC ever lands in the factory
        // (airdrop, mistyped destination), no market can drain it.
        // Note: if Circle USDC rejects 0-amount approve on a future network,
        // skip this line and add to mainnet TODO.
        IERC20(usdc).approve(address(market), 0);

        // Transfer ownership to caller so they can closeBetting/settle/cancel
        market.transferOwnership(msg.sender);

        // Register
        allMarkets.push(address(market));
        marketByGameId[gameId]          = address(market);
        gameIdByMarket[address(market)] = gameId;

        emit MarketCreated(address(market), gameId, oracleZ, spreadMax, spreadMin, feePercent, msg.sender);

        return address(market);
    }
}
