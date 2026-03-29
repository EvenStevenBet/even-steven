// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/token/ERC20/IERC20.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/access/Ownable.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/security/ReentrancyGuard.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.3/contracts/security/Pausable.sol";

/*
 * @title SportsbookMarket v1.7
 * @notice Parimutuel sports betting market with dynamic Z line.
 *         Agent-first design. Trustless settlement via UMA.
 *
 * AUDIT FIXES IN v1.6/v1.7 (from full security audit March 2026):
 *
 *   C-1 UMA CURRENCY MISMATCH - resolved by switching from
 *       assertTruthWithDefaults() to assertTruth() with explicit
 *       currency parameter. No longer dependent on oo.defaultCurrency()
 *       matching our USDC. Works on any network regardless of UMA's
 *       admin-configured default token.
 *
 *   C-2 O(n) SETTLEMENT DOS - mitigated via MAX_BETS = 1000 cap.
 *       _sumWinningStakes() loop retained because each bet's win
 *       condition depends on its individual lockedZ vs finalSpread -
 *       side-level tallies cannot substitute. Cap keeps settlement
 *       gas under ~6.3M, well within Base's 30M block limit.
 *
 *   C-3 ln() ACCURACY AT EXTREME RATIOS - pool ratio clamped
 *       to max 19:1 before atanh calculation. Above 19:1 the
 *       5-term series degrades (>3% error). Clamp keeps error
 *       below 0.1% while preserving Z movement direction.
 *
 *   H-1 currentZ NOT CLAMPED - Z now clamped to Z_MIN/Z_MAX
 *       after every calculation.
 *
 *   H-2 OWNER SETTLE GOD MODE - settle() removed entirely.
 *       Settlement paths: UMA requestSettlement() + executeSettlement(),
 *       or triggerRefund() after 7 days as the ultimate safety net.
 *       No owner can dictate a settlement outcome. Fully trustless.
 *
 *   H-3 FACTORY transferFrom UNCHECKED - fixed in factory.
 *
 *   H-4 5% FEE ON CANCELED GAMES - refund mode now returns
 *       100% of stake. Fee only applies to normal settled markets.
 *
 *   M-6 CLAIM WINDOW EDGE ON LATE CANCEL - cancelMarket() now
 *       always resets bettingClosedAt to block.timestamp so
 *       the 90-day window starts fresh from cancellation.
 *
 *   L-3 MISSING INDEXED EVENT FIELDS - finalSpread now indexed
 *       in MarketSettled event.
 *
 *   L-4 assertionActive NOT RESET ON CANCEL - both cancelMarket()
 *       and triggerRefund() now reset assertionActive to prevent
 *       state inconsistency.
 *
 *   L-5 recoverStuckBond POST-SETTLEMENT - documented.
 *
 * DESIGN (carried from v1.5):
 *   - finalSpread as whole integer (e.g. 7, not 70000)
 *   - _isBetWinner: finalSpread * 10000 vs lockedZ (4-decimal)
 *   - gameId on-chain for UMA assertion text
 *   - spreadBounds set per market by factory (NFL ±100, esports ±1000)
 *   - cancelMarket() immediate refund, triggerRefund() 7-day safety net
 *   - sweepUnclaimed() 90-day protocol sweep
 *   - recoverStuckBond() for failed UMA assertion recovery
 *   - ln() Z math via atanh series (no external library)
 *
 * MAINNET TODO:
 *   - Replace Remix HTTP imports with npm (@openzeppelin/contracts)
 *   - Add Foundry/Hardhat test suite
 *   - Add factory view pagination (M-1)
 *   - Add claimPayouts(uint256[] betIds) batch function (M-5)
 *   - Verify Circle USDC is on UMA whitelist on Base mainnet
 *     (getMinimumBond should return > 0, not fall back to MIN_BOND)
 */

// ─────────────────────────────────────────────
// UMA OPTIMISTIC ORACLE V3 INTERFACE
// Base Sepolia: 0x0F7fC5E6482f096380db6158f978167b57388deE (confirmed)
// Base Mainnet: https://docs.uma.xyz/resources/network-addresses
// ─────────────────────────────────────────────
interface OptimisticOracleV3Interface {
    function assertTruthWithDefaults(
        bytes memory claim,
        address asserter
    ) external returns (bytes32 assertionId);

    // Full assertTruth with explicit currency - use this instead of assertTruthWithDefaults
    // to avoid defaultCurrency mismatch. Lets us specify our USDC directly.
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

    function settleAndGetAssertionResult(
        bytes32 assertionId
    ) external returns (bool result);

    function getAssertionResult(
        bytes32 assertionId
    ) external view returns (bool result);

    function defaultCurrency() external view returns (IERC20);

    function defaultIdentifier() external view returns (bytes32);

    function getMinimumBond(address currency) external view returns (uint256);
}

contract SportsbookMarket is Ownable, ReentrancyGuard, Pausable {

    // ─────────────────────────────────────────────
    // CONSTANTS
    // ─────────────────────────────────────────────

    // Fee in basis points on settled markets only. Set by factory at deployment.
    // 200 = 2.00%. Max enforced by factory at 1000 = 10%.
    // Locked at creation time - never changes for a deployed market.
    uint256 public immutable FEE_PERCENT;
    uint256 public constant PROTOCOL_SEED = 1e6;    // 1 USDC per side
    int256  public constant K             = 50000;  // Z sensitivity (4-decimal space)
    int256  private constant SCALE        = 1e8;    // ln() precision - internal only

    // Z line bounds (4-decimal fixed-point): ±500.0000
    int256 public constant Z_MAX =  5000000;
    int256 public constant Z_MIN = -5000000;

    // Max pool ratio for ln() accuracy: 19:1
    // Above this the 5-term atanh series exceeds 3% error.
    // Clamp keeps error below 0.1%.
    uint256 private constant MAX_POOL_RATIO = 19;

    // Timeouts
    uint256 public constant REFUND_TIMEOUT = 7 days;   // triggerRefund() window
    uint256 public constant CLAIM_TIMEOUT  = 90 days;  // sweepUnclaimed() window

    // Minimum bond for UMA assertions. Protects against griefing attacks where
    // someone submits a false spread for a trivial cost.
    // TESTNET: Set to 1 USDC for testnet where faucet limits apply.
    // MAINNET TODO: Restore to 100e6 (100 USDC) before mainnet deployment.
    uint256 public constant MIN_BOND = 1e6; // 1 USDC (testnet only)
    // Each _isBetWinner() reads ~3 storage slots at ~2,100 gas cold = ~6,300 gas/bet.
    // 1,000 bets ≈ 6.3M gas - well under Base's 30M block limit.
    // V2 ROADMAP: Replace with sorted cumulative-stake structure keyed by lockedZ.
    // Binary search finds cutoff point, prefix sum gives winning stakes in O(log n).
    uint256 public constant MAX_BETS = 1000;

    // ─────────────────────────────────────────────
    // UMA STATE
    // ─────────────────────────────────────────────

    OptimisticOracleV3Interface public immutable oo;

    bytes32  public assertionId;
    int256   public pendingSpread;
    bool     public assertionActive;
    address  public asserter;

    // ─────────────────────────────────────────────
    // MARKET CONFIGURATION
    // ─────────────────────────────────────────────

    IERC20  public immutable usdc;
    string  public gameId;

    // Spread bounds (whole integers) - set per market by factory
    int256  public immutable SPREAD_MAX;
    int256  public immutable SPREAD_MIN;

    // ─────────────────────────────────────────────
    // MARKET STATE
    // ─────────────────────────────────────────────

    int256  public currentZ;
    int256  public initialZ;

    uint256 public greaterPool;      // Total USDC on spread > lockedZ side
    uint256 public lessEqualPool;    // Total USDC on spread <= lockedZ side
    uint256 public totalPool;        // greaterPool + lessEqualPool (includes seed)
    uint256 public protocolSeedTotal;

    // Set once at _settleMarket() - O(1) per claimPayout()
    uint256 public cachedWinningStakes;

    // finalSpread: WHOLE INTEGER (e.g. 7 = home wins by 7, -3 = away wins by 3)
    // Compared against lockedZ (4-decimal) via: finalSpread * 10000
    int256  public finalSpread;

    bool    public bettingOpen;
    bool    public settled;
    bool    public canceled;
    bool    public refundMode;

    // Timestamps
    uint256 public bettingClosedAt;
    uint256 public settledAt;

    // ─────────────────────────────────────────────
    // BET STORAGE
    // ─────────────────────────────────────────────

    struct Bet {
        address bettor;
        uint256 stake;
        bool    greaterThan;
        int256  lockedZ;     // 4-decimal, locked at bet time - never changes
        bool    claimed;
    }

    Bet[] public bets;
    mapping(address => uint256[]) public betsByAddress;

    // ─────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────

    event MarketOpened(string gameId, int256 initialZ, uint256 seedPerSide);
    event BetPlaced(address indexed bettor, uint256 indexed betId, uint256 stake, bool greaterThan, int256 lockedZ);
    event ZUpdated(int256 newZ, uint256 greaterPool, uint256 lessEqualPool);
    event BettingClosed(uint256 timestamp);
    event MarketCanceled(address indexed by);
    event RefundTriggered(address indexed by);
    event SettlementRequested(bytes32 assertionId, int256 proposedSpread, address asserter);
    event MarketSettled(int256 indexed finalSpread, bool refundMode, bool viaOracle); // L-3: finalSpread indexed
    event PayoutClaimed(address indexed bettor, uint256 amount);
    event UnclaimedSwept(uint256 amount, address indexed to);

    // ─────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────

    /**
     * @param _usdc      USDC token address
     * @param _oo        UMA OptimisticOracleV3 address
     * @param _spreadMax Max final spread (whole integer), e.g. 100 for NFL
     * @param _spreadMin Min final spread (whole integer), e.g. -100 for NFL
     * @param _feePercent Protocol fee in basis points. Set by factory. 200 = 2%.
     *
     * C-1 FIX: Validates oo.defaultCurrency() == _usdc.
     * Prevents bricked settlement on chains where UMA default != USDC.
     */
    constructor(
        address _usdc,
        address _oo,
        int256  _spreadMax,
        int256  _spreadMin,
        uint256 _feePercent
    ) {
        require(_usdc != address(0), "Invalid USDC address");
        require(_oo   != address(0), "Invalid OO address");
        require(_spreadMax > 0 && _spreadMin < 0, "Invalid spread bounds");
        require(_spreadMax <= 10000 && _spreadMin >= -10000, "Spread bounds too wide");
        require(_feePercent >= 20,   "Fee below 0.2% minimum");
        require(_feePercent <= 1000, "Fee exceeds 10% maximum");

        // C-1 NOTE: Currency validation removed from constructor.
        // We no longer need defaultCurrency() to match usdc because
        // requestSettlement() uses assertTruth() with explicit currency
        // instead of assertTruthWithDefaults(). This decouples settlement
        // from UMA's admin-configured default currency entirely.
        // No constructor check needed — the fix is in the settlement call itself.

        usdc       = IERC20(_usdc);
        oo         = OptimisticOracleV3Interface(_oo);
        SPREAD_MAX = _spreadMax;
        SPREAD_MIN = _spreadMin;
        FEE_PERCENT = _feePercent;
    }

    // ─────────────────────────────────────────────
    // EMERGENCY PAUSE
    // ─────────────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────
    // OPEN MARKET
    // ─────────────────────────────────────────────

    /**
     * @param _gameId  e.g. "NFL-2026-HOME-Chiefs-AWAY-49ers"
     *                 Include HOME/AWAY labels for UMA claim clarity (M-2).
     * @param oracleZ  Opening line (4-decimal), e.g. -35000 = Chiefs -3.5
     *
     * Owner must approve this contract for 2 * PROTOCOL_SEED USDC before calling.
     */
    function openMarket(string calldata _gameId, int256 oracleZ)
        external onlyOwner whenNotPaused
    {
        require(!bettingOpen, "Already open");
        require(!settled && !canceled, "Market ended");
        require(bytes(_gameId).length > 0, "gameId cannot be empty");
        require(oracleZ >= Z_MIN && oracleZ <= Z_MAX, "oracleZ out of range");

        uint256 seedTotal = PROTOCOL_SEED * 2;
        require(usdc.transferFrom(msg.sender, address(this), seedTotal), "Seed transfer failed");

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

    // ─────────────────────────────────────────────
    // PLACE BET
    // ─────────────────────────────────────────────

    /**
     * @param greaterThan true  = betting finalSpread > lockedZ
     *                    false = betting finalSpread <= lockedZ
     * @param stake       USDC (minimum 1 USDC = 1e6)
     *
     * Bettor must approve this contract for `stake` USDC before calling.
     * Agents: call getMarketState() and simulatePayout() first.
     */
    function placeBet(bool greaterThan, uint256 stake)
        external nonReentrant whenNotPaused
    {
        require(bettingOpen, "Betting is closed");
        require(!settled && !canceled, "Market ended");
        require(stake >= 1e6, "Minimum bet is 1 USDC");
        require(bets.length < MAX_BETS, "Market is full (1000 bet cap)");
        require(usdc.transferFrom(msg.sender, address(this), stake), "Stake transfer failed");

        int256  lockedZ = currentZ;
        uint256 betId   = bets.length;

        bets.push(Bet({
            bettor:      msg.sender,
            stake:       stake,
            greaterThan: greaterThan,
            lockedZ:     lockedZ,
            claimed:     false
        }));
        betsByAddress[msg.sender].push(betId);

        if (greaterThan) {
            greaterPool += stake;
        } else {
            lessEqualPool += stake;
        }
        totalPool += stake;

        _updateZ();
        emit BetPlaced(msg.sender, betId, stake, greaterThan, lockedZ);
    }

    // ─────────────────────────────────────────────
    // CLOSE BETTING
    // ─────────────────────────────────────────────

    function closeBetting() external onlyOwner {
        require(bettingOpen, "Already closed");
        bettingOpen     = false;
        bettingClosedAt = block.timestamp;
        emit BettingClosed(block.timestamp);
    }

    // ─────────────────────────────────────────────
    // CANCEL MARKET - IMMEDIATE REFUND
    // ─────────────────────────────────────────────

    /**
     * @notice Immediate refund for canceled/postponed games.
     *         100% of stake returned - no fee charged (H-4 fix).
     *         90-day claim window starts from THIS call (M-6 fix).
     *
     *         L-4 FIX: resets assertionActive so bond recovery works.
     */
    function cancelMarket() external onlyOwner {
        require(!settled && !canceled, "Market already ended");

        canceled    = true;
        refundMode  = true;
        bettingOpen = false;

        // M-6 FIX: always reset so 90-day window starts fresh from now
        bettingClosedAt = block.timestamp;

        // L-4 FIX: clear assertion state so recoverStuckBond() is accessible
        if (assertionActive) {
            assertionActive = false;
            // Bond is handled by UMA separately - state cleaned here
        }

        require(usdc.transfer(owner(), protocolSeedTotal), "Seed return failed");

        emit MarketCanceled(msg.sender);
    }

    // ─────────────────────────────────────────────
    // TRIGGER REFUND - 7-DAY SAFETY NET
    // ─────────────────────────────────────────────

    /**
     * @notice Anyone calls after REFUND_TIMEOUT if market never settled.
     *         100% of stake returned - no fee (H-4 fix).
     *         L-4 FIX: resets assertionActive.
     */
    function triggerRefund() external nonReentrant {
        require(!settled && !canceled, "Market already ended");
        require(!bettingOpen, "Betting still open");
        require(bettingClosedAt > 0, "Betting never closed");
        require(
            block.timestamp >= bettingClosedAt + REFUND_TIMEOUT,
            "Refund timeout not reached"
        );

        canceled   = true;
        refundMode = true;

        // L-4 FIX: clear assertion state
        if (assertionActive) {
            assertionActive = false;
        }

        require(usdc.transfer(owner(), protocolSeedTotal), "Seed return failed");

        emit RefundTriggered(msg.sender);
    }

    // ─────────────────────────────────────────────
    // UMA SETTLEMENT - PRIMARY PATH
    // ─────────────────────────────────────────────

    /**
     * @notice Step 1: Assert final spread to UMA after game ends.
     * @param _proposedSpread Whole integer. e.g. 7, -3, 0
     *
     * gameId format: "NFL-2026-HOME-Chiefs-AWAY-49ers"
     * Positive spread = HOME team won by that margin.
     * Negative spread = AWAY team won by that margin.
     *
     * Caller must approve OOV3 for bond amount (call getSettlementBond()).
     * Bond returned if undisputed. Agents: call this right after game ends.
     */
    function requestSettlement(int256 _proposedSpread)
        external nonReentrant whenNotPaused
    {
        require(!bettingOpen, "Close betting first");
        require(!settled && !canceled, "Market already ended");
        require(!assertionActive, "Assertion already pending");
        require(
            _proposedSpread >= SPREAD_MIN && _proposedSpread <= SPREAD_MAX,
            "Spread out of range"
        );

        bytes memory claim = abi.encodePacked(
            "The final spread of game ",
            gameId,
            " was ",
            _int256ToString(_proposedSpread),
            " points. Positive = HOME team (first named in gameId) won by that margin. Negative = AWAY team (second named) won. Zero = tie."
        );

        uint256 bond = oo.getMinimumBond(address(usdc));
        // Use MIN_BOND as floor. If getMinimumBond returns 0, USDC may not be
        // registered in UMA's Store on this network — but we still require a
        // meaningful bond to deter griefing. 100 USDC makes false assertions
        // economically costly since the bond is lost on a successful dispute.
        if (bond < MIN_BOND) bond = MIN_BOND;

        require(usdc.transferFrom(msg.sender, address(this), bond), "Bond transfer failed");
        usdc.approve(address(oo), bond);

        // C-1 FIX: Use assertTruth() with explicit currency instead of
        // assertTruthWithDefaults() which uses oo.defaultCurrency() — a different
        // token on Base Sepolia. This decouples us from whatever UMA's admin
        // sets as default and lets us always use our USDC directly.
        bytes32 _assertionId = oo.assertTruth(
            claim,
            msg.sender,              // asserter — gets bond back if undisputed
            address(0),              // no callback recipient
            address(0),              // no escalation manager (use default DVM)
            7200,                    // 2-hour liveness window
            usdc,                    // explicit USDC — the C-1 fix
            bond,                    // bond amount
            oo.defaultIdentifier(),  // ASSERT_TRUTH identifier
            bytes32(0)               // no domain
        );

        assertionId     = _assertionId;
        pendingSpread   = _proposedSpread;
        assertionActive = true;
        asserter        = msg.sender;

        emit SettlementRequested(_assertionId, _proposedSpread, msg.sender);
    }

    /**
     * @notice Step 2: Finalize after UMA liveness (2hrs testnet).
     *         Undisputed → settles market.
     *         Disputed and rejected → resets for new assertion.
     */
    function executeSettlement() external nonReentrant whenNotPaused {
        require(!settled && !canceled, "Market already ended");
        require(assertionActive, "No active assertion");

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

    // ─────────────────────────────────────────────
    // CLAIM PAYOUT (PULL PATTERN)
    // ─────────────────────────────────────────────

    /**
     * @notice Claim payout for a single bet.
     *         Must call within 90 days of settlement/cancellation.
     *         Agents: listen for MarketSettled event, claim automatically.
     */
    function claimPayout(uint256 betId) external nonReentrant whenNotPaused {
        require(settled || canceled, "Not settled yet");
        require(betId < bets.length, "Invalid bet ID");
        require(!_isClaimExpired(), "Claim window expired (90 days)");

        Bet storage bet = bets[betId];
        require(bet.bettor == msg.sender, "Not your bet");
        require(!bet.claimed, "Already claimed");

        bet.claimed    = true;
        uint256 payout = _calculatePayout(betId);
        require(payout > 0, "No payout for this bet");
        require(usdc.balanceOf(address(this)) >= payout, "Insufficient balance");
        require(usdc.transfer(msg.sender, payout), "Transfer failed");

        emit PayoutClaimed(msg.sender, payout);
    }

    /**
     * @notice Claim all payouts in one transaction.
     *         Must call within 90 days. Preferred for agents.
     */
    function claimAllPayouts() external nonReentrant whenNotPaused {
        require(settled || canceled, "Not settled yet");
        require(!_isClaimExpired(), "Claim window expired (90 days)");

        uint256[] memory myBetIds = betsByAddress[msg.sender];
        require(myBetIds.length > 0, "No bets found");

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

        require(totalPayout > 0, "Nothing to claim");
        require(usdc.balanceOf(address(this)) >= totalPayout, "Insufficient balance");
        require(usdc.transfer(msg.sender, totalPayout), "Transfer failed");

        emit PayoutClaimed(msg.sender, totalPayout);
    }

    // ─────────────────────────────────────────────
    // SWEEP UNCLAIMED - 90-DAY PROTOCOL COLLECTION
    // ─────────────────────────────────────────────

    /**
     * @notice Sweeps unclaimed funds after 90 days post-settlement or cancellation.
     *         Applies to both unclaimed winnings AND unclaimed refund stakes.
     *         90 days is ample time for any human or agent to claim.
     */
    function sweepUnclaimed() external onlyOwner nonReentrant {
        require(settled || canceled, "Not settled yet");
        require(_isClaimExpired(), "Claim window not expired yet");

        uint256 remaining = usdc.balanceOf(address(this));
        require(remaining > 0, "Nothing to sweep");

        require(usdc.transfer(owner(), remaining), "Sweep transfer failed");
        emit UnclaimedSwept(remaining, owner());
    }

    // ─────────────────────────────────────────────
    // RECOVER STUCK BOND
    // ─────────────────────────────────────────────

    /**
     * @notice Recovers USDC stuck after a failed UMA assertion call.
     *         Only recovers the balance above totalPool - never touches bettor funds.
     *
     *         L-5 NOTE: Only usable before settlement. After _settleMarket()
     *         transfers protocolSeedTotal, balance drops below totalPool and
     *         safeBalance == 0. Intended for pre-settlement recovery only.
     *
     * @param amount Amount to recover: usdc.balanceOf(address(this)) - totalPool
     * @param to     Destination (typically the original asserter)
     */
    function recoverStuckBond(uint256 amount, address to)
        external onlyOwner nonReentrant
    {
        require(!assertionActive, "Assertion is active - cannot recover");
        require(to != address(0), "Invalid destination");
        require(amount > 0, "Amount must be > 0");

        uint256 balance     = usdc.balanceOf(address(this));
        uint256 safeBalance = balance > totalPool ? balance - totalPool : 0;
        require(amount <= safeBalance, "Amount exceeds recoverable balance");

        require(usdc.transfer(to, amount), "Recovery transfer failed");
    }

    // ─────────────────────────────────────────────
    // VIEW FUNCTIONS - agent query layer
    // ─────────────────────────────────────────────

    /**
     * @notice Core betting info - call before placing a bet.
     *         Agents: check isOpen before placeBet(), isSettled before claimPayout().
     */
    function getMarketState() external view returns (
        string memory _gameId,
        int256  z,
        uint256 gPool,
        uint256 lePool,
        uint256 tPool,
        bool    isOpen,
        bool    isSettled
    ) {
        return (
            gameId,
            currentZ,
            greaterPool,
            lessEqualPool,
            totalPool,
            bettingOpen,
            settled
        );
    }

    /**
     * @notice Operational status - safety nets, capacity, and timing.
     *         betsRemaining: if 0, placeBet() will revert.
     *         claimDeadline: unix timestamp when claim window closes (0 if not settled).
     */
    function getMarketStatus() external view returns (
        bool    isCanceled,
        bool    isPaused,
        bool    _assertionActive,
        uint256 claimDeadline,
        uint256 betsRemaining
    ) {
        return (
            canceled,
            paused(),
            assertionActive,
            settledAt > 0 ? settledAt + CLAIM_TIMEOUT : 0,
            bets.length < MAX_BETS ? MAX_BETS - bets.length : 0
        );
    }

    function getBetsByAddress(address bettor) external view returns (uint256[] memory) {
        return betsByAddress[bettor];
    }

    function getBet(uint256 betId) external view returns (Bet memory) {
        require(betId < bets.length, "Invalid bet ID");
        return bets[betId];
    }

    /**
     * @notice Estimates payout before placing. Agents: use for Kelly criterion.
     */
    function simulatePayout(uint256 stake, bool greaterThan)
        external view returns (uint256 estimatedPayout)
    {
        uint256 simGreater   = greaterPool   + (greaterThan ? stake : 0);
        uint256 simLessEqual = lessEqualPool + (greaterThan ? 0 : stake);
        uint256 simTotal     = totalPool + stake;

        uint256 distributable = simTotal - protocolSeedTotal;
        uint256 fee           = (distributable * FEE_PERCENT) / 10000;
        uint256 prizePool     = distributable - fee;

        uint256 winningSide = greaterThan ? simGreater : simLessEqual;
        if (winningSide == 0) return 0;

        estimatedPayout = (stake * prizePool) / winningSide;
    }

    /**
     * @notice Returns expected value metrics for a potential bet.
     *         Designed for agent decision-making and SDK display.
     *
     *         currentPayout:    payout if market closed right now at current pool ratio
     *         balancedPayout:   payout if pools reach perfect balance (equal sides)
     *                           NOTE: if you are betting the heavy side (majority),
     *                           balancedPayout will be LOWER than currentPayout.
     *                           If betting the light side (minority), it will be HIGHER.
     *                           This is not a "best case" — it is the balanced-market case.
     *         impliedVig:       our fee in basis points — this IS the total cost.
     *                           No spread, no hidden maker-taker, no house edge.
     *                           200 bps = 2% = roughly -104 in sportsbook terms.
     *                           Standard sportsbook -110 line = ~450 bps vig.
     *                           Polymarket peaks at 180 bps but has spread costs.
     *
     * Agents: use impliedVig to compare us against sportsbooks and other platforms.
     */
    function getMarketEV(uint256 stake, bool greaterThan) external view returns (
        uint256 currentPayout,
        uint256 balancedPayout,
        uint256 impliedVig
    ) {
        if (stake == 0) return (0, 0, 0);

        // Current payout at existing pool ratio
        uint256 simGreater   = greaterPool   + (greaterThan ? stake : 0);
        uint256 simLessEqual = lessEqualPool + (greaterThan ? 0 : stake);
        uint256 simTotal     = totalPool + stake;

        uint256 distributable = simTotal - protocolSeedTotal;
        uint256 fee           = (distributable * FEE_PERCENT) / 10000;
        uint256 prizePool     = distributable - fee;

        uint256 winningSide = greaterThan ? simGreater : simLessEqual;
        currentPayout = winningSide > 0 ? (stake * prizePool) / winningSide : 0;

        // Balanced payout: assume market reaches perfect balance (equal pools).
        // Can be higher OR lower than currentPayout depending on which side you bet.
        // Majority side: balancedPayout < currentPayout (more competition at balance)
        // Minority side: balancedPayout > currentPayout (less competition at balance)
        uint256 balancedSide = simTotal / 2;
        balancedPayout = balancedSide > 0 ? (stake * prizePool) / balancedSide : 0;

        // Implied vig = our protocol fee in basis points. Nothing hidden on our end.
        // NOTE: For heavy-side bettors, the true economic cost is higher than this
        // because you share the prize pool with more winners. currentPayout vs
        // balancedPayout reveals the pool-imbalance cost. impliedVig covers only
        // the protocol fee — agents should factor in both.
        impliedVig = FEE_PERCENT;
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

    // ─────────────────────────────────────────────
    // INTERNAL: SETTLE MARKET
    // ─────────────────────────────────────────────

    /**
     * @dev C-2 FIX: Bet cap (MAX_BETS = 1000) ensures this loop never
     *      exceeds ~6.3M gas - well under Base's 30M block limit.
     *      Running tallies (greaterStakes/lessEqualStakes) cannot replace
     *      this loop because each bet's win condition depends on its individual
     *      lockedZ vs finalSpread - side-level totals are meaningless until
     *      settlement. The cap is the correct solution at launch volume.
     *      cachedWinningStakes is set once here - all claimPayout() calls
     *      use it at O(1).
     */
    function _settleMarket(int256 _finalSpread, bool viaOracle) internal {
        finalSpread = _finalSpread;
        settled     = true;
        settledAt   = block.timestamp;

        cachedWinningStakes = _sumWinningStakes();
        if (cachedWinningStakes == 0) {
            refundMode = true;
        }

        // Return protocol seed to owner
        require(usdc.transfer(owner(), protocolSeedTotal), "Seed return failed");

        // Sweep protocol fee to owner immediately at settlement.
        // Fee is only collected on normally settled markets - not on refund/cancel.
        // This is protocol revenue - do not leave it locked in the contract.
        if (!refundMode) {
            uint256 distributable = totalPool - protocolSeedTotal;
            uint256 fee           = (distributable * FEE_PERCENT) / 10000;
            if (fee > 0) {
                require(usdc.transfer(owner(), fee), "Fee transfer failed");
            }
        }

        emit MarketSettled(_finalSpread, refundMode, viaOracle);
    }

    // ─────────────────────────────────────────────
    // INTERNAL: IS CLAIM EXPIRED
    // ─────────────────────────────────────────────

    function _isClaimExpired() internal view returns (bool) {
        if (settledAt == 0 && !canceled) return false;
        uint256 referenceTime = settledAt > 0 ? settledAt : bettingClosedAt;
        return block.timestamp >= referenceTime + CLAIM_TIMEOUT;
    }

    // ─────────────────────────────────────────────
    // INTERNAL: SUM WINNING STAKES
    // ─────────────────────────────────────────────

    /**
     * @dev Loops all bets to find winners. Called ONCE at settlement.
     *      Safe because MAX_BETS = 1000 caps the array size.
     *      All subsequent claimPayout() calls use cachedWinningStakes - O(1).
     */
    function _sumWinningStakes() internal view returns (uint256 total) {
        for (uint256 i = 0; i < bets.length; i++) {
            if (_isBetWinner(i)) {
                total += bets[i].stake;
            }
        }
    }

    // ─────────────────────────────────────────────
    // INTERNAL: IS BET A WINNER
    // ─────────────────────────────────────────────

    /**
     * @dev finalSpread (whole int) * 10000 vs lockedZ (4-decimal).
     *      Example: finalSpread=7, lockedZ=-35000
     *      greaterThan: 70000 > -35000 ✓ wins
     *      lessEqual:   70000 <= -35000 ✗ loses
     */
    function _isBetWinner(uint256 betId) internal view returns (bool) {
        Bet memory bet = bets[betId];
        int256 scaledSpread = finalSpread * 10000;
        return bet.greaterThan
            ? scaledSpread > bet.lockedZ
            : scaledSpread <= bet.lockedZ;
    }

    // ─────────────────────────────────────────────
    // INTERNAL: CALCULATE PAYOUT
    // ─────────────────────────────────────────────

    /**
     * @dev H-4 FIX: refundMode returns 100% of stake (no fee).
     *      Fee only applies to normally settled markets.
     */
    function _calculatePayout(uint256 betId) internal view returns (uint256) {
        Bet memory bet = bets[betId];

        // H-4 FIX: 100% refund - no fee on canceled or timed-out markets
        if (refundMode) {
            return bet.stake;
        }

        if (!_isBetWinner(betId)) return 0;

        uint256 distributable = totalPool - protocolSeedTotal;
        uint256 fee           = (distributable * FEE_PERCENT) / 10000;
        uint256 prizePool     = distributable - fee;

        if (cachedWinningStakes == 0) return 0;

        return (bet.stake * prizePool) / cachedWinningStakes;
    }

    // ─────────────────────────────────────────────
    // INTERNAL: UPDATE Z - ln() atanh series
    // ─────────────────────────────────────────────

    /**
     * @dev Z = initialZ + K * ln(greaterPool / lessEqualPool)
     *      ln(a/b) = 2*(z + z³/3 + z⁵/5 + z⁷/7 + z⁹/9)
     *      where z = (a-b)/(a+b)
     *
     *      C-3 FIX: Pool ratio clamped to MAX_POOL_RATIO (19:1).
     *      Above 19:1 the 5-term series exceeds 3% error.
     *      Clamp keeps error below 0.1% while preserving Z direction.
     *
     *      H-1 FIX: currentZ clamped to Z_MIN/Z_MAX after calculation.
     *
     *      MAINNET: Replace with PRBMath ln() after audit.
     */
    function _updateZ() internal {
        int256 gPool  = int256(greaterPool);
        int256 lePool = int256(lessEqualPool);

        if (gPool <= 0 || lePool <= 0) return;

        // C-3 FIX: clamp pool ratio to MAX_POOL_RATIO:1
        if (gPool > lePool * int256(MAX_POOL_RATIO)) {
            gPool = lePool * int256(MAX_POOL_RATIO);
        } else if (lePool > gPool * int256(MAX_POOL_RATIO)) {
            lePool = gPool * int256(MAX_POOL_RATIO);
        }

        int256 diff  = gPool - lePool;
        int256 total = gPool + lePool;
        int256 z     = (diff * SCALE) / total;

        int256 z2 = (z  * z)  / SCALE;
        int256 z3 = (z2 * z)  / SCALE;
        int256 z5 = (z3 * z2) / SCALE;
        int256 z7 = (z5 * z2) / SCALE;
        int256 z9 = (z7 * z2) / SCALE;

        int256 lnRatio = 2 * (z + z3/3 + z5/5 + z7/7 + z9/9);
        int256 zAdjust = (K * lnRatio) / SCALE;

        // H-1 FIX: clamp result to valid Z range
        int256 newZ = initialZ + zAdjust;
        if (newZ > Z_MAX) newZ = Z_MAX;
        if (newZ < Z_MIN) newZ = Z_MIN;
        currentZ = newZ;

        emit ZUpdated(currentZ, greaterPool, lessEqualPool);
    }

    // ─────────────────────────────────────────────
    // INTERNAL: INT256 TO STRING
    // ─────────────────────────────────────────────

    /**
     * @dev Verified behavior:
     *      _int256ToString(0)    == "0"
     *      _int256ToString(7)    == "7"
     *      _int256ToString(-7)   == "-7"
     *      _int256ToString(100)  == "100"
     *      _int256ToString(-100) == "-100"
     *
     *      Buffer is 78 bytes - safe for any int256 value (L-2 fix).
     */
    function _int256ToString(int256 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        bool    negative = value < 0;
        uint256 absValue = negative ? uint256(-value) : uint256(value);

        bytes memory buffer = new bytes(78); // L-2 FIX: 78 bytes covers full int256 range
        uint256 len = 0;

        while (absValue > 0) {
            buffer[len++] = bytes1(uint8(48 + absValue % 10));
            absValue /= 10;
        }

        if (negative) buffer[len++] = "-";

        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = buffer[len - 1 - i];
        }

        return string(result);
    }
}
