// SPDX-License-Identifier: MIT
// SportsbookMarket v1.11
// CHANGES FROM v1.10:
//   - claimPayoutFor(address,uint256[]): permissionless relayed claim. Any
//     relay may submit; the payout (or refund) is ALWAYS sent to the bettor
//     recorded on the bet, never to msg.sender. Completes the gasless path
//     opened by placeBetFor() — a bettor can bet and claim holding no ETH.
//   - BetClaimed / SettlementDetails events (ADDITIVE): per-bet claim attribution and
//     settlement payout parameters. PayoutClaimed and MarketSettled are unchanged.
//   - _requireNotPaused()/_checkOwner() overridden: MarketPaused()/NotOwner() custom
//     errors replace OpenZeppelin's require-strings. unpause() is unchanged.
//   - placeBetForWithSignature(address,bool,uint256,AuthorizationBytes): the same
//     relayed bet entry point for signers whose signature is not 65-byte ECDSA —
//     smart-contract wallets (ERC-1271) and EIP-7702-delegated accounts. placeBetFor
//     is unchanged and stays the path for plain EOAs.
//
// CHANGES FROM v1.9 (carried):
//   - placeBetFor(): non-custodial agent betting via EIP-3009
//     receiveWithAuthorization. The bettor signs; any relay may submit.
//     `bettor` (the EIP-3009 signer) is recorded as owner, not msg.sender.
//   - PROTOCOL_SEED is now a per-market immutable (may be 0), not a constant.
//   - getMarketEV()/simulatePayout() no longer count the protocol seed as a
//     competing winning stake (matches _sumWinningStakes()).
//   - claimPayouts(uint256[]) batch claim.
//
// CHANGES FROM v1.8.1 (carried):
//   - V-1 FIX (launch blocker): UMA assertion identifier is now a constructor
//     param (ASSERTION_IDENTIFIER) instead of a hardcoded oo.defaultIdentifier()
//     call. v1.8.1 markets settle against ASSERT_TRUTH, which UMA deprecated
//     Dec 15, 2025 — every settlement attempt on this factory's markets reverts.
//   - PE-1 FIX: claimPayout() / claimAllPayouts() no longer carry whenNotPaused,
//     so owner-triggered pause can never block withdrawal of already-settled funds.
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
error InvalidIdentifier();
error BadAuthorizationNonce();
error InvalidBettor();
error MarketPaused();
error NotOwner();

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

/// @dev EIP-3009 as actually implemented by Circle FiatTokenV2.2 on Base
///      (proxy 0x8335...2913 -> impl 0x2Ce6311ddAE708829bc0784C967b7d77D19FD779).
///      receiveWithAuthorization is used rather than transferWithAuthorization:
///      it requires msg.sender == to, so a signed authorization cannot be
///      redeemed by anyone except this market inside placeBetFor(). See R6-1.
interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @dev The bytes-signature overload (FiatTokenV2_2). USDC verifies an EOA
    ///      signature with ecrecover and a contract signer through ERC-1271, so a
    ///      signature that is not 65-byte ECDSA can only be redeemed through this one.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract SportsbookMarket is Ownable, ReentrancyGuard, Pausable {

    // ── v1.9 (V-1 FIX) ───────────────────────────────
    // v1.8.1 hardcoded oo.defaultIdentifier() at requestSettlement() time.
    // On Base mainnet that resolved to ASSERT_TRUTH, which UMA deprecated
    // Dec 15, 2025 (UMIP-191) and removed from the IdentifierWhitelist.
    // Every settlement made by a v1.8.1 market reverts as a result.
    //
    // Fix: identifier is now set once at deployment and stored here, so a
    // future UMA identifier change never requires another contract redeploy
    // — only a new factory default (see SportsbookFactory.settlementIdentifier).
    // Existing v1.8.1 markets cannot be patched; they are wound down via
    // triggerRefund().
    bytes32 public immutable ASSERTION_IDENTIFIER;

    uint256 public immutable FEE_PERCENT;       // taker fee in bps; 200 = 2%
    uint256 public immutable PROTOCOL_SEED;     // per side; may be 0
    int256  public constant K              = 50000;
    int256  private constant SCALE         = 1e8;
    int256  public constant Z_MAX          =  5000000;
    int256  public constant Z_MIN          = -5000000;
    uint256 private constant MAX_POOL_RATIO = 19;
    // R6-6: notional per-side stand-in used ONLY for the pool-ratio computation
    // inside _updateZ(), and ONLY on a seedless market. It is never added to
    // greaterPool, lessEqualPool, totalPool or protocolSeedTotal, never enters
    // `distributable`, and never reaches _calculatePayout(). Its value matches
    // the 1 USDC/side that seeded markets have used since v1.8.1, so a seedless
    // market's line behaves identically to a seeded one at every stake size
    // while locking none of the creator's capital.
    int256  private constant Z_VIRTUAL_SEED = 1e6;
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

    /// @notice EIP-3009 authorization bundle for placeBetFor().
    /// @dev Grouped into a calldata struct rather than flat parameters: nine
    ///      flat params overflow the stack under the non-viaIR pipeline this
    ///      project compiles with in Remix.
    struct Authorization {
        uint256 validAfter;   // EIP-3009 validAfter  (unix seconds)
        uint256 validBefore;  // EIP-3009 validBefore (unix seconds)
        bytes32 nonce;        // the EIP-3009 nonce actually signed
        bytes32 salt;         // bettor-chosen; nonce MUST equal keccak256(salt, greaterThan)
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice EIP-3009 authorization whose signature is opaque bytes, for
    ///         placeBetForWithSignature(). Same fields as Authorization, except the
    ///         signature is not split into v/r/s — a contract wallet's signature has
    ///         no such decomposition.
    struct AuthorizationBytes {
        uint256 validAfter;   // EIP-3009 validAfter  (unix seconds)
        uint256 validBefore;  // EIP-3009 validBefore (unix seconds)
        bytes32 nonce;        // MUST equal keccak256(abi.encode(salt, greaterThan))
        bytes32 salt;         // bettor-chosen; nonce MUST equal keccak256(salt, greaterThan)
        bytes   signature;    // EOA: abi.encodePacked(r,s,v). Contract wallet: its own format.
    }

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
    /// @notice Per-bet claim attribution. The BetClaimed payouts within one transaction
    ///         sum to that transaction's PayoutClaimed.amount.
    event BetClaimed(address indexed bettor, uint256 indexed betId, uint256 payout);
    /// @notice Emitted once at settlement. With BetPlaced(stake) this makes any bet's
    ///         payout computable from events alone:
    ///         refundMode ? stake : (isWinner ? stake * distributable / winningStakes : 0)
    event SettlementDetails(uint256 distributable, uint256 winningStakes);

    constructor(
        address _usdc,
        address _oo,
        int256  _spreadMax,
        int256  _spreadMin,
        uint256 _feePercent,
        bytes32 _identifier,
        uint256 _protocolSeed
    ) {
        if (_usdc == address(0) || _oo == address(0)) revert InvalidAddress();
        if (_spreadMax <= 0 || _spreadMin >= 0) revert InvalidSpreadBounds();
        if (_spreadMax > 10000 || _spreadMin < -10000) revert SpreadBoundsTooWide();
        if (_feePercent < 20)   revert FeeTooLow();
        if (_feePercent > 1000) revert FeeTooHigh();
        if (_identifier == bytes32(0)) revert InvalidIdentifier();

        usdc               = IERC20(_usdc);
        oo                 = OptimisticOracleV3Interface(_oo);
        SPREAD_MAX         = _spreadMax;
        SPREAD_MIN         = _spreadMin;
        FEE_PERCENT        = _feePercent;
        ASSERTION_IDENTIFIER = _identifier;
        PROTOCOL_SEED        = _protocolSeed;
    }

    // C1: machine-readable replacements for OZ's require-strings on the two guards agents hit.
    function _requireNotPaused() internal view override { if (paused()) revert MarketPaused(); }
    function _checkOwner() internal view override { if (owner() != _msgSender()) revert NotOwner(); }

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
        if (seedTotal > 0) {
            if (!usdc.transferFrom(msg.sender, address(this), seedTotal)) revert SeedTransferFailed();
        }

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
        uint256 fee = _preBet(stake);

        // ── INTERACTION 1: pull stake + fee from the bettor ──────────
        if (!usdc.transferFrom(msg.sender, address(this), stake + fee)) revert StakeTransferFailed();

        _recordBet(msg.sender, greaterThan, stake, fee);
    }

    /**
     * @notice Place a bet funded by `bettor`'s EIP-3009 authorization, submitted
     *         by any relay. `bettor` — the signer — is recorded as the bet owner
     *         and is the only address that can claim the payout.
     *
     * @dev PERMISSIONLESS BY DESIGN. There is deliberately no allowlist on
     *      msg.sender; the only authorization that matters is the bettor's
     *      EIP-3009 signature, which USDC itself verifies. This matches the
     *      protocol's no-owner-override posture.
     *
     * @dev R6-1 (front-running): uses receiveWithAuthorization, NOT
     *      transferWithAuthorization. transferWithAuthorization can be submitted
     *      by anybody, so an observer could redeem the authorization straight
     *      against USDC — moving the bettor's funds into this contract while
     *      recording no bet, and burning the nonce so placeBetFor then reverts.
     *      receiveWithAuthorization requires msg.sender == to, so the
     *      authorization is only redeemable from inside this function.
     *
     * @dev R6-2 (side binding): the EIP-3009 signature covers
     *      (from, to, value, validAfter, validBefore, nonce) — it does NOT cover
     *      `greaterThan`. A relay could otherwise take an authorization intended
     *      for one side and place it on the other, as the counterparty. The
     *      bettor therefore must sign a nonce of the form
     *          nonce = keccak256(abi.encode(salt, greaterThan))
     *      which this function re-derives from `auth.salt` and `greaterThan` and
     *      checks against `auth.nonce` before touching USDC. A signed nonce is
     *      thus a commitment to one side of the line.
     *
     *      `stake` is already bound without extra work: value == stake + fee is
     *      signed, and value is strictly increasing in stake, so exactly one
     *      stake maps to a given signed value. `bettor` is bound as the
     *      authorization's `from`, and this market is bound as its `to` — an
     *      authorization cannot be replayed against a different market.
     *
     *      NOTE FOR AGENT INTEGRATORS: this nonce derivation is a deliberate
     *      divergence from a vanilla x402 payload, which uses a random nonce.
     *      A random nonce is rejected with BadAuthorizationNonce() — a distinct,
     *      machine-readable error — rather than surfacing as USDC's generic
     *      "invalid signature" string.
     *
     * @param bettor       EIP-3009 signer; recorded as bet owner and payout recipient
     * @param greaterThan  side of the line — committed to via the derived nonce
     * @param stake        stake in USDC base units (fee is added on top)
     * @param auth         the bettor's EIP-3009 authorization (see Authorization)
     */
    function placeBetFor(
        address bettor,
        bool    greaterThan,
        uint256 stake,
        Authorization calldata auth
    ) external nonReentrant whenNotPaused {
        if (bettor == address(0)) revert InvalidBettor();
        // R6-2: reject a nonce that is not bound to this side BEFORE calling
        // USDC, so the failure is a distinct custom error rather than USDC's
        // generic "FiatTokenV2: invalid signature" string.
        if (auth.nonce != keccak256(abi.encode(auth.salt, greaterThan))) revert BadAuthorizationNonce();
        uint256 fee = _preBet(stake);

        // ── INTERACTION 1: redeem the bettor's signed authorization ──
        // USDC verifies the signature, the validAfter/validBefore window and
        // nonce reuse itself, reverting with its own FiatTokenV2 reason strings.
        IEIP3009(address(usdc)).receiveWithAuthorization(
            bettor,
            address(this),
            stake + fee,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,                 // R6-2: checked against salt+side above
            auth.v, auth.r, auth.s
        );

        _recordBet(bettor, greaterThan, stake, fee);
    }

    /**
     * @notice placeBetFor for signers whose signature is not 65-byte ECDSA: smart-contract
     *         wallets (verified by USDC via ERC-1271) and EIP-7702-delegated accounts.
     *         Identical checks to placeBetFor; the signature is passed to USDC as opaque
     *         bytes and USDC does all verification. EOAs may use either function.
     * @dev Same R6-2 rule: auth.nonce must equal keccak256(abi.encode(auth.salt,
     *      greaterThan)), else BadAuthorizationNonce(). Bettor is recorded as owner; funds
     *      move bettor -> market only.
     */
    function placeBetForWithSignature(
        address bettor, bool greaterThan, uint256 stake, AuthorizationBytes calldata auth
    ) external nonReentrant whenNotPaused {
        if (bettor == address(0)) revert InvalidBettor();
        if (auth.nonce != keccak256(abi.encode(auth.salt, greaterThan))) revert BadAuthorizationNonce();
        uint256 fee = _preBet(stake);
        IEIP3009(address(usdc)).receiveWithAuthorization(
            bettor, address(this), stake + fee,
            auth.validAfter, auth.validBefore, auth.nonce, auth.signature
        );
        _recordBet(bettor, greaterThan, stake, fee);
    }

    /// @dev Shared pre-flight for both bet entry points. Returns the taker fee.
    function _preBet(uint256 stake) internal view returns (uint256) {
        if (!bettingOpen) revert BettingIsClosed();
        if (settled || canceled) revert MarketEnded();
        if (stake < 1e6) revert BelowMinBet();
        if (bets.length >= MAX_BETS) revert MarketFull();
        // FEE_PERCENT is bounded [20, 1000] in the constructor, so stake + fee
        // cannot overflow at any realistic stake size.
        return (stake * FEE_PERCENT) / 10000;
    }

    /**
     * @dev Shared effects + fee sweep for both bet entry points. Funds for
     *      (stake + fee) must already have been pulled into this contract.
     *
     *      AVAILABILITY (R5-2): the fee sweep transfers USDC to owner() on EVERY
     *      bet. If owner() cannot receive USDC (Circle blacklist, or a contract
     *      owner that reverts on receipt), betting reverts (FeeTransferFailed)
     *      and the market becomes unbettable. Market ownership MUST be an address
     *      that can always accept USDC.
     */
    function _recordBet(address bettor, bool greaterThan, uint256 stake, uint256 fee) internal {
        // ── EFFECTS: all state mutations complete before the fee sweep ───
        int256  lockedZ = currentZ;
        uint256 betId   = bets.length;

        bets.push(Bet({
            bettor:      bettor,
            stake:       stake,           // stake only — fee not stored
            greaterThan: greaterThan,
            lockedZ:     lockedZ,
            claimed:     false
        }));
        betsByAddress[bettor].push(betId);

        if (greaterThan) { greaterPool += stake; }
        else             { lessEqualPool += stake; }
        totalPool += stake;

        _updateZ();
        emit BetPlaced(bettor, betId, stake, fee, greaterThan, lockedZ);

        // ── INTERACTION 2: sweep fee to protocol owner (LAST) ────────
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
        _returnSeed();
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
        _returnSeed();
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
            ASSERTION_IDENTIFIER,   // v1.9 (V-1 FIX): was oo.defaultIdentifier()
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

    // v1.9 (PE-1 FIX): whenNotPaused removed. A paused market must still let
    // already-settled bettors withdraw — pause() is for stopping new bets and
    // new settlement actions, not for freezing money that is already owed.
    // Leaving whenNotPaused here let owner() (or a compromised owner key)
    // pause the contract after settlement and permanently trap payouts.
    function claimPayout(uint256 betId) external nonReentrant {
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

        emit BetClaimed(msg.sender, betId, payout);
        emit PayoutClaimed(msg.sender, payout);
    }

    // v1.9 (PE-1 FIX): whenNotPaused removed — see claimPayout() above.
    function claimAllPayouts() external nonReentrant {
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
                    emit BetClaimed(msg.sender, myBetIds[i], payout);
                }
            }
        }

        if (totalPayout == 0) revert NothingToClaim();
        if (usdc.balanceOf(address(this)) < totalPayout) revert InsufficientBalance();
        if (!usdc.transfer(msg.sender, totalPayout)) revert TransferFailed();

        emit PayoutClaimed(msg.sender, totalPayout);
    }

    /**
     * @notice Claim a specific set of bets in one transaction.
     * @dev Unlike claimAllPayouts(), which silently skips already-claimed bets,
     *      this reverts on an already-claimed or non-winning betId exactly as the
     *      single-bet claimPayout() path does — an explicit betId list is an
     *      assertion about those bets, so a bad entry is an error, not a no-op.
     */
    function claimPayouts(uint256[] calldata betIds) external nonReentrant {
        if (!settled && !canceled) revert NotSettledYet();
        if (_isClaimExpired()) revert ClaimWindowExpired();
        if (betIds.length == 0) revert NothingToClaim();

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < betIds.length; i++) {
            uint256 betId = betIds[i];
            if (betId >= bets.length) revert InvalidBetId();
            Bet storage bet = bets[betId];
            if (bet.bettor != msg.sender) revert NotYourBet();
            if (bet.claimed) revert AlreadyClaimed();

            uint256 payout = _calculatePayout(betId);
            if (payout == 0) revert NoPayout();
            bet.claimed  = true;
            totalPayout += payout;
            emit BetClaimed(msg.sender, betId, payout);
        }

        if (usdc.balanceOf(address(this)) < totalPayout) revert InsufficientBalance();
        if (!usdc.transfer(msg.sender, totalPayout)) revert TransferFailed();

        emit PayoutClaimed(msg.sender, totalPayout);
    }

    /**
     * @notice Claim the payout (or refund) for `bettor`'s bets, submitted by any relay.
     *         The USDC is ALWAYS sent to `bettor` — the address recorded on the bet —
     *         never to msg.sender. The relay never custodies funds.
     *
     * @dev PERMISSIONLESS, NO SIGNATURE. EIP-3009 authorizes USDC moving from a signer;
     *      a claim moves USDC from this market to the bettor, so there is nothing for the
     *      bettor to authorize, and the fixed destination makes a signature redundant.
     *      Replay/double-claim protection is bet.claimed, exactly as in claimPayout /
     *      claimPayouts: a second call for the same id reverts AlreadyClaimed.
     *
     *      Semantics are identical to claimPayouts(): strict and atomic. An already-claimed,
     *      non-winning, out-of-range or someone-else's id reverts the whole call and moves
     *      nothing. A relay must therefore submit only claimable ids.
     *
     *      Like claimPayout, deliberately NOT whenNotPaused (PE-1): pause must never block
     *      withdrawal of money already owed. Works in refund mode too.
     *
     *      Known property: anyone can trigger a bettor's claim at a time the bettor did not
     *      choose. They cannot redirect or custody the funds. A bettor's own direct claim
     *      may revert AlreadyClaimed if a relay claimed first — the money has already landed.
     */
    function claimPayoutFor(address bettor, uint256[] calldata betIds) external nonReentrant {
        if (!settled && !canceled) revert NotSettledYet();
        if (_isClaimExpired()) revert ClaimWindowExpired();
        if (betIds.length == 0) revert NothingToClaim();

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < betIds.length; i++) {
            uint256 betId = betIds[i];
            if (betId >= bets.length) revert InvalidBetId();
            Bet storage bet = bets[betId];
            if (bet.bettor != bettor) revert NotYourBet();
            if (bet.claimed) revert AlreadyClaimed();

            uint256 payout = _calculatePayout(betId);
            if (payout == 0) revert NoPayout();
            bet.claimed  = true;
            totalPayout += payout;
            emit BetClaimed(bettor, betId, payout);
        }

        if (usdc.balanceOf(address(this)) < totalPayout) revert InsufficientBalance();
        if (!usdc.transfer(bettor, totalPayout)) revert TransferFailed();

        emit PayoutClaimed(bettor, totalPayout);
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

    /**
     * @notice Quote the payout for a hypothetical stake.
     * @dev v1.10 QUOTE FIX: the winning-side denominator now EXCLUDES this
     *      side's protocol seed, matching _sumWinningStakes(), which has never
     *      counted the seed as a winning stake. v1.9 and earlier divided by a
     *      denominator that included the seed and therefore under-quoted —
     *      worst on thin pools. Settlement itself was always correct.
     */
    function simulatePayout(uint256 stake, bool greaterThan)
        external view returns (uint256 estimatedPayout)
    {
        if (stake == 0) return 0;
        uint256 seedPerSide   = protocolSeedTotal / 2;
        uint256 winningSide   = (greaterThan ? greaterPool : lessEqualPool) - seedPerSide + stake;
        uint256 distributable = totalPool - protocolSeedTotal + stake;
        if (winningSide == 0) return 0;
        // No fee deduction — fee was paid up front at bet placement
        estimatedPayout = (stake * distributable) / winningSide;
    }

    /**
     * @notice Current and steady-state payout quote for a hypothetical stake.
     * @dev v1.10 QUOTE FIX — see simulatePayout(). liquidPayout is the payout
     *      when both sides hold equal real stake: winning stakes are then exactly
     *      half of distributable, so the payout is exactly 2x the stake.
     */
    function getMarketEV(uint256 stake, bool greaterThan) external view returns (
        uint256 currentPayout, uint256 liquidPayout, uint256 impliedVig
    ) {
        if (stake == 0) return (0, 0, 0);
        uint256 seedPerSide   = protocolSeedTotal / 2;
        uint256 winningSide   = (greaterThan ? greaterPool : lessEqualPool) - seedPerSide + stake;
        uint256 distributable = totalPool - protocolSeedTotal + stake;
        // No fee deduction — fee was paid up front at bet placement
        currentPayout = winningSide > 0 ? (stake * distributable) / winningSide : 0;
        liquidPayout  = stake * 2;
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

        _returnSeed();

        emit SettlementDetails(totalPool - protocolSeedTotal, cachedWinningStakes);
        emit MarketSettled(_finalSpread, refundMode, viaOracle);
    }

    /// @dev Returns the protocol seed to the owner. No-op when the market was
    ///      created seedless (PROTOCOL_SEED == 0).
    function _returnSeed() internal {
        uint256 seed = protocolSeedTotal;
        if (seed > 0) {
            if (!usdc.transfer(owner(), seed)) revert SeedTransferFailed();
        }
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
        // R6-6 (v1.10): on a seedless market, add a notional seed to BOTH sides
        // for ratio purposes only. v1.9 relied on a nonzero PROTOCOL_SEED to keep
        // both pools positive here and returned early otherwise; with a
        // configurable seed that early return would freeze a seedless market's
        // line at initialZ for its entire one-sided opening window — exactly when
        // the line most needs to move to attract opposing flow.
        //
        // Applying it to both sides (rather than only to an empty side) makes a
        // seedless market's Z identical to a seeded market's at every stake size,
        // including a lone minimum bet. Seeded markets are unaffected: vSeed is 0
        // for them, so their Z behaviour is byte-for-byte what v1.9 produced.
        //
        // Both pools are strictly positive in either branch — seeded markets hold
        // at least PROTOCOL_SEED per side, seedless markets get vSeed — so the
        // divide-by-zero this guard originally existed to prevent stays impossible.
        int256 vSeed  = protocolSeedTotal == 0 ? Z_VIRTUAL_SEED : int256(0);
        int256 gPool  = int256(greaterPool)   + vSeed;
        int256 lePool = int256(lessEqualPool) + vSeed;

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
