// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@4.9.3/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts@4.9.3/access/Ownable.sol";
import "@openzeppelin/contracts@4.9.3/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts@4.9.3/security/Pausable.sol";

// Custom errors replace long revert strings to reduce bytecode size
error InvalidAddress();
error InvalidSpreadBounds();
error SpreadBoundsTooWide();
error FeeTooLow();
error FeeTooHigh();
error AlreadyOpen();
error MarketEnded();
error EmptyGameId();
error OracleZOutOfRange();
error SeedTransferFailed();
error BettingIsClosed();
error BelowMinBet();
error MarketFull();
error StakeTransferFailed();
error AlreadyClosed();
error MarketAlreadyEnded();
error BettingStillOpen();
error BettingNeverClosed();
error RefundTimeoutNotReached();
error CloseFirstBeforeSettlement();
error AssertionAlreadyPending();
error SpreadOutOfRange();
error BondTransferFailed();
error NoActiveAssertion();
error NotSettledYet();
error InvalidBetId();
error ClaimWindowExpired();
error NotYourBet();
error AlreadyClaimed();
error NoPayout();
error InsufficientBalance();
error TransferFailed();
error NothingToClaim();
error ClaimWindowNotExpired();
error NothingToSweep();
error AssertionIsActive();
error InvalidDestination();
error AmountZero();
error AmountExceedsRecoverable();
error FeeTransferFailed();

interface OptimisticOracleV3Interface {
    function assertTruth(
        bytes memory claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64  liveness,
        IERC20  currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);

    function settleAndGetAssertionResult(bytes32 assertionId) external returns (bool result);
    function defaultIdentifier() external view returns (bytes32);
    function getMinimumBond(address currency) external view returns (uint256);
}

contract SportsbookMarket is Ownable, ReentrancyGuard, Pausable {

    uint256 public immutable FEE_PERCENT;       // taker fee in bps; 200 = 2%
    uint256 public constant PROTOCOL_SEED  = 1e6;
    int256  public constant K              = 50000;
    int256  private constant SCALE         = 1e8;
    int256  public constant Z_MAX          =  5000000;
    int256  public constant Z_MIN          = -5000000;
    uint256 private constant MAX_POOL_RATIO = 19;
    uint256 public constant REFUND_TIMEOUT = 7 days;
    uint256 public constant CLAIM_TIMEOUT  = 90 days;
    uint256 public constant MIN_BOND       = 100e6;
    uint256 public constant MAX_BETS       = 1000;

    OptimisticOracleV3Interface public immutable oo;
    bytes32  public assertionId;
    int256   public pendingSpread;
    bool     public assertionActive;
    address  public asserter;

    IERC20  public immutable usdc;
    string  public gameId;
    int256  public immutable SPREAD_MAX;
    int256  public immutable SPREAD_MIN;

    int256  public currentZ;
    int256  public initialZ;
    uint256 public greaterPool;          // stakes only — fees never enter the pool
    uint256 public lessEqualPool;        // stakes only — fees never enter the pool
    uint256 public totalPool;            // greaterPool + lessEqualPool + seed
    uint256 public protocolSeedTotal;
    uint256 public cachedWinningStakes;
    int256  public finalSpread;

    bool    public bettingOpen;
    bool    public settled;
    bool    public canceled;
    bool    public refundMode;
    uint256 public bettingClosedAt;
    uint256 public settledAt;

    struct Bet {
        address bettor;
        uint256 stake;        // stake only — fee paid separately at placement
        bool    greaterThan;
        int256  lockedZ;
        bool    claimed;
    }

    Bet[] public bets;
    mapping(address => uint256[]) public betsByAddress;

    event MarketOpened(string gameId, int256 initialZ, uint256 seedPerSide);
    event BetPlaced(
        address indexed bettor,
        uint256 indexed betId,
        uint256 stake,
        uint256 fee,
        bool    greaterThan,
        int256  lockedZ
    );
    event ZUpdated(int256 newZ, uint256 greaterPool, uint256 lessEqualPool);
    event BettingClosed(uint256 timestamp);
    event MarketCanceled(address indexed by);
    event RefundTriggered(address indexed by);
    event SettlementRequested(bytes32 assertionId, int256 proposedSpread, address asserter);
    event MarketSettled(int256 indexed finalSpread, bool refundMode, bool viaOracle);
    event PayoutClaimed(address indexed bettor, uint256 amount);
    event UnclaimedSwept(uint256 amount, address indexed to);

    constructor(
        address _usdc,
        address _oo,
        int256  _spreadMax,
        int256  _spreadMin,
        uint256 _feePercent
    ) {
        if (_usdc == address(0) || _oo == address(0)) revert InvalidAddress();
        if (_spreadMax <= 0 || _spreadMin >= 0) revert InvalidSpreadBounds();
        if (_spreadMax > 10000 || _spreadMin < -10000) revert SpreadBoundsTooWide();
        if (_feePercent < 20)   revert FeeTooLow();
        if (_feePercent > 1000) revert FeeTooHigh();

        usdc        = IERC20(_usdc);
        oo          = OptimisticOracleV3Interface(_oo);
        SPREAD_MAX  = _spreadMax;
        SPREAD_MIN  = _spreadMin;
        FEE_PERCENT = _feePercent;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function openMarket(string calldata _gameId, int256 oracleZ)
        external onlyOwner whenNotPaused
    {
        if (bettingOpen) revert AlreadyOpen();
        if (settled || canceled) revert MarketEnded();
        if (bytes(_gameId).length == 0) revert EmptyGameId();
        if (oracleZ < Z_MIN || oracleZ > Z_MAX) revert OracleZOutOfRange();

        uint256 seedTotal = PROTOCOL_SEED * 2;
        if (!usdc.transferFrom(msg.sender, address(this), seedTotal)) revert SeedTransferFailed();

        gameId            = _gameId;
        initialZ          = oracleZ;
        currentZ          = oracleZ;
        greaterPool       = PROTOCOL_SEED;
        lessEqualPool     = PROTOCOL_SEED;
        totalPool         = seedTotal;
        protocolSeedTotal = seedTotal;
        bettingOpen       = true;

        emit MarketOpened(_gameId, oracleZ, PROTOCOL_SEED);
    }

    /**
     * @notice Place a bet. A taker fee of (stake * FEE_PERCENT / 10000) is added on top
     *         of the stake and swept to the market owner in the same transaction. Only
     *         the stake enters the pool.
     * @dev AVAILABILITY (R5-2): the fee sweep transfers USDC to owner() on EVERY bet.
     *      If owner() cannot receive USDC (e.g. a Circle blacklist, or a contract owner
     *      that reverts on receipt), placeBet reverts (FeeTransferFailed) and the market
     *      becomes unbettable. Market ownership MUST be an address that can always accept
     *      USDC. The factory transfers market ownership to the creator, so any whitelisted
     *      operator address is subject to the same requirement.
     */
    function placeBet(bool greaterThan, uint256 stake)
        external nonReentrant whenNotPaused
    {
        if (!bettingOpen) revert BettingIsClosed();
        if (settled || canceled) revert MarketEnded();
        if (stake < 1e6) revert BelowMinBet();
        if (bets.length >= MAX_BETS) revert MarketFull();

        // Taker fee = stake * FEE_PERCENT / 10000.
        // FEE_PERCENT is bounded [20, 1000] in constructor, so totalCost
        // overflow is not a concern at any realistic stake size.
        uint256 fee       = (stake * FEE_PERCENT) / 10000;
        uint256 totalCost = stake + fee;

        // ── INTERACTION 1: pull stake + fee into contract ────────────
        // Must come first — cannot record a bet before funds arrive.
        if (!usdc.transferFrom(msg.sender, address(this), totalCost)) revert StakeTransferFailed();

        // ── EFFECTS: all state mutations complete before fee sweep ───
        int256  lockedZ = currentZ;
        uint256 betId   = bets.length;

        bets.push(Bet({
            bettor:      msg.sender,
            stake:       stake,           // stake only — fee not stored
            greaterThan: greaterThan,
            lockedZ:     lockedZ,
            claimed:     false
        }));
        betsByAddress[msg.sender].push(betId);

        if (greaterThan) { greaterPool += stake; }
        else             { lessEqualPool += stake; }
        totalPool += stake;

        _updateZ();
        emit BetPlaced(msg.sender, betId, stake, fee, greaterThan, lockedZ);

        // ── INTERACTION 2: sweep fee to protocol owner (LAST) ────────
        // All bet state is committed before this call. nonReentrant
        // blocks recursion into other functions; CEI ordering ensures
        // any reentrant view sees a finished state.
        if (fee > 0) {
            if (!usdc.transfer(owner(), fee)) revert FeeTransferFailed();
        }
    }

    function closeBetting() external onlyOwner {
        if (!bettingOpen) revert AlreadyClosed();
        bettingOpen     = false;
        bettingClosedAt = block.timestamp;
        emit BettingClosed(block.timestamp);
    }

    function cancelMarket() external onlyOwner {
        if (settled || canceled) revert MarketAlreadyEnded();
        canceled        = true;
        refundMode      = true;
        bettingOpen     = false;
        bettingClosedAt = block.timestamp;
        if (assertionActive) { assertionActive = false; }
        if (!usdc.transfer(owner(), protocolSeedTotal)) revert SeedTransferFailed();
        emit MarketCanceled(msg.sender);
    }

    function triggerRefund() external nonReentrant {
        if (settled || canceled) revert MarketAlreadyEnded();
        if (bettingOpen) revert BettingStillOpen();
        if (bettingClosedAt == 0) revert BettingNeverClosed();
        if (block.timestamp < bettingClosedAt + REFUND_TIMEOUT) revert RefundTimeoutNotReached();

        canceled   = true;
        refundMode = true;
        if (assertionActive) { assertionActive = false; }
        if (!usdc.transfer(owner(), protocolSeedTotal)) revert SeedTransferFailed();
        emit RefundTriggered(msg.sender);
    }

    function requestSettlement(int256 _proposedSpread)
        external nonReentrant whenNotPaused
    {
        if (bettingOpen) revert CloseFirstBeforeSettlement();
        if (settled || canceled) revert MarketAlreadyEnded();
        if (assertionActive) revert AssertionAlreadyPending();
        if (_proposedSpread < SPREAD_MIN || _proposedSpread > SPREAD_MAX) revert SpreadOutOfRange();

        bytes memory claim = abi.encodePacked(
            "The final spread of game ",
            gameId,
            " was ",
            _int256ToString(_proposedSpread),
            " points. Positive = HOME team (first named in gameId) won by that margin. Negative = AWAY team (second named) won. Zero = tie."
        );

        uint256 bond = oo.getMinimumBond(address(usdc));
        if (bond < MIN_BOND) bond = MIN_BOND;

        if (!usdc.transferFrom(msg.sender, address(this), bond)) revert BondTransferFailed();
        usdc.approve(address(oo), bond);

        bytes32 _assertionId = oo.assertTruth(
            claim,
            msg.sender,
            address(0),
            address(0),
            7200,
            usdc,
            bond,
            oo.defaultIdentifier(),
            bytes32(0)
        );

        assertionId     = _assertionId;
        pendingSpread   = _proposedSpread;
        assertionActive = true;
        asserter        = msg.sender;

        emit SettlementRequested(_assertionId, _proposedSpread, msg.sender);
    }

    function executeSettlement() external nonReentrant whenNotPaused {
        if (settled || canceled) revert MarketAlreadyEnded();
        if (!assertionActive) revert NoActiveAssertion();

        bool result = oo.settleAndGetAssertionResult(assertionId);

        if (result) {
            assertionActive = false;
            _settleMarket(pendingSpread, true);
        } else {
            assertionActive = false;
            assertionId     = bytes32(0);
            pendingSpread   = 0;
            asserter        = address(0);
        }
    }

    function claimPayout(uint256 betId) external nonReentrant whenNotPaused {
        if (!settled && !canceled) revert NotSettledYet();
        if (betId >= bets.length) revert InvalidBetId();
        if (_isClaimExpired()) revert ClaimWindowExpired();

        Bet storage bet = bets[betId];
        if (bet.bettor != msg.sender) revert NotYourBet();
        if (bet.claimed) revert AlreadyClaimed();

        bet.claimed    = true;
        uint256 payout = _calculatePayout(betId);
        if (payout == 0) revert NoPayout();
        if (usdc.balanceOf(address(this)) < payout) revert InsufficientBalance();
        if (!usdc.transfer(msg.sender, payout)) revert TransferFailed();

        emit PayoutClaimed(msg.sender, payout);
    }

    function claimAllPayouts() external nonReentrant whenNotPaused {
        if (!settled && !canceled) revert NotSettledYet();
        if (_isClaimExpired()) revert ClaimWindowExpired();

        uint256[] memory myBetIds = betsByAddress[msg.sender];
        if (myBetIds.length == 0) revert NothingToClaim();

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < myBetIds.length; i++) {
            Bet storage bet = bets[myBetIds[i]];
            if (!bet.claimed) {
                uint256 payout = _calculatePayout(myBetIds[i]);
                if (payout > 0) {
                    bet.claimed  = true;
                    totalPayout += payout;
                }
            }
        }

        if (totalPayout == 0) revert NothingToClaim();
        if (usdc.balanceOf(address(this)) < totalPayout) revert InsufficientBalance();
        if (!usdc.transfer(msg.sender, totalPayout)) revert TransferFailed();

        emit PayoutClaimed(msg.sender, totalPayout);
    }

    function sweepUnclaimed() external onlyOwner nonReentrant {
        if (!settled && !canceled) revert NotSettledYet();
        if (!_isClaimExpired()) revert ClaimWindowNotExpired();

        uint256 remaining = usdc.balanceOf(address(this));
        if (remaining == 0) revert NothingToSweep();
        if (!usdc.transfer(owner(), remaining)) revert TransferFailed();
        emit UnclaimedSwept(remaining, owner());
    }

    function recoverStuckBond(uint256 amount, address to)
        external onlyOwner nonReentrant
    {
        if (assertionActive) revert AssertionIsActive();
        if (to == address(0)) revert InvalidDestination();
        if (amount == 0) revert AmountZero();

        uint256 balance     = usdc.balanceOf(address(this));
        uint256 safeBalance = balance > totalPool ? balance - totalPool : 0;
        if (amount > safeBalance) revert AmountExceedsRecoverable();
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }

    // ── VIEW FUNCTIONS ──────────────────────────────

    function getMarketState() external view returns (
        string memory _gameId, int256 z, uint256 gPool,
        uint256 lePool, uint256 tPool, bool isOpen, bool isSettled
    ) {
        return (gameId, currentZ, greaterPool, lessEqualPool, totalPool, bettingOpen, settled);
    }

    function getMarketStatus() external view returns (
        bool isCanceled, bool isPaused, bool _assertionActive,
        uint256 claimDeadline, uint256 betsRemaining
    ) {
        return (
            canceled, paused(), assertionActive,
            settledAt > 0 ? settledAt + CLAIM_TIMEOUT : 0,
            bets.length < MAX_BETS ? MAX_BETS - bets.length : 0
        );
    }

    function getBetsByAddress(address bettor) external view returns (uint256[] memory) {
        return betsByAddress[bettor];
    }

    function getBet(uint256 betId) external view returns (Bet memory) {
        if (betId >= bets.length) revert InvalidBetId();
        return bets[betId];
    }

    function simulatePayout(uint256 stake, bool greaterThan)
        external view returns (uint256 estimatedPayout)
    {
        uint256 simGreater   = greaterPool   + (greaterThan ? stake : 0);
        uint256 simLessEqual = lessEqualPool + (greaterThan ? 0 : stake);
        uint256 simTotal     = totalPool + stake;
        uint256 distributable = simTotal - protocolSeedTotal;
        uint256 winningSide   = greaterThan ? simGreater : simLessEqual;
        if (winningSide == 0) return 0;
        // No fee deduction — fee was paid up front at bet placement
        estimatedPayout = (stake * distributable) / winningSide;
    }

    function getMarketEV(uint256 stake, bool greaterThan) external view returns (
        uint256 currentPayout, uint256 liquidPayout, uint256 impliedVig
    ) {
        if (stake == 0) return (0, 0, 0);
        uint256 simGreater   = greaterPool   + (greaterThan ? stake : 0);
        uint256 simLessEqual = lessEqualPool + (greaterThan ? 0 : stake);
        uint256 simTotal     = totalPool + stake;
        uint256 distributable = simTotal - protocolSeedTotal;
        // No fee deduction — fee was paid up front at bet placement
        uint256 winningSide   = greaterThan ? simGreater : simLessEqual;
        currentPayout  = winningSide > 0 ? (stake * distributable) / winningSide : 0;
        uint256 liquidSide = simTotal / 2;
        liquidPayout  = liquidSide > 0 ? (stake * distributable) / liquidSide : 0;
        impliedVig    = FEE_PERCENT;
    }

    function getSettlementBond() external view returns (uint256) {
        return oo.getMinimumBond(address(usdc));
    }

    function canTriggerRefund() external view returns (bool) {
        return (
            !settled && !canceled && !bettingOpen &&
            bettingClosedAt > 0 &&
            block.timestamp >= bettingClosedAt + REFUND_TIMEOUT
        );
    }

    function canSweepUnclaimed() external view returns (bool) {
        return (settled || canceled) && _isClaimExpired();
    }

    // ── INTERNALS ───────────────────────────────────

    function _settleMarket(int256 _finalSpread, bool viaOracle) internal {
        finalSpread = _finalSpread;
        settled     = true;
        settledAt   = block.timestamp;

        cachedWinningStakes = _sumWinningStakes();
        if (cachedWinningStakes == 0) { refundMode = true; }

        if (!usdc.transfer(owner(), protocolSeedTotal)) revert SeedTransferFailed();

        emit MarketSettled(_finalSpread, refundMode, viaOracle);
    }

    function _isClaimExpired() internal view returns (bool) {
        if (settledAt == 0 && !canceled) return false;
        uint256 referenceTime = settledAt > 0 ? settledAt : bettingClosedAt;
        return block.timestamp >= referenceTime + CLAIM_TIMEOUT;
    }

    function _sumWinningStakes() internal view returns (uint256 total) {
        for (uint256 i = 0; i < bets.length; i++) {
            if (_isBetWinner(i)) { total += bets[i].stake; }
        }
    }

    function _isBetWinner(uint256 betId) internal view returns (bool) {
        Bet memory bet = bets[betId];
        int256 scaledSpread = finalSpread * 10000;
        return bet.greaterThan ? scaledSpread > bet.lockedZ : scaledSpread <= bet.lockedZ;
    }

    function _calculatePayout(uint256 betId) internal view returns (uint256) {
        Bet memory bet = bets[betId];
        if (refundMode) { return bet.stake; }
        if (!_isBetWinner(betId)) return 0;
        uint256 distributable = totalPool - protocolSeedTotal;
        if (cachedWinningStakes == 0) return 0;
        return (bet.stake * distributable) / cachedWinningStakes;
    }

    function _updateZ() internal {
        int256 gPool  = int256(greaterPool);
        int256 lePool = int256(lessEqualPool);
        if (gPool <= 0 || lePool <= 0) return;

        if (gPool > lePool * int256(MAX_POOL_RATIO))       { gPool  = lePool * int256(MAX_POOL_RATIO); }
        else if (lePool > gPool * int256(MAX_POOL_RATIO))  { lePool = gPool  * int256(MAX_POOL_RATIO); }

        int256 diff  = gPool - lePool;
        int256 total = gPool + lePool;
        int256 z     = (diff * SCALE) / total;
        int256 z2    = (z  * z)  / SCALE;
        int256 z3    = (z2 * z)  / SCALE;
        int256 z5    = (z3 * z2) / SCALE;
        int256 z7    = (z5 * z2) / SCALE;
        int256 z9    = (z7 * z2) / SCALE;
        int256 lnRatio = 2 * (z + z3/3 + z5/5 + z7/7 + z9/9);
        int256 zAdjust = (K * lnRatio) / SCALE;

        int256 newZ = initialZ + zAdjust;
        if (newZ > Z_MAX) newZ = Z_MAX;
        if (newZ < Z_MIN) newZ = Z_MIN;
        currentZ = newZ;

        emit ZUpdated(currentZ, greaterPool, lessEqualPool);
    }

    function _int256ToString(int256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        bool    negative = value < 0;
        uint256 absValue = negative ? uint256(-value) : uint256(value);
        bytes memory buffer = new bytes(78);
        uint256 len = 0;
        while (absValue > 0) {
            buffer[len++] = bytes1(uint8(48 + absValue % 10));
            absValue /= 10;
        }
        if (negative) buffer[len++] = "-";
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) { result[i] = buffer[len - 1 - i]; }
        return string(result);
    }
}
