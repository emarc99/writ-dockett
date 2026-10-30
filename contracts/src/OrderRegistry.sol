// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CREReceiver} from "./interfaces/CREReceiver.sol";

/// @title OrderRegistry
/// @notice On-chain record of court orders verified (or rejected) by the Writ CRE workflows.
///         A wallet is frozen only while an Active order names it and that order has not expired.
///         Expiry is evaluated against block.timestamp at read time, so a 14-day ex parte TRO
///         stops freezing wallets on day 15 even if no transaction is ever sent.
/// @dev Rejection reason bits (set by the verify workflow): 1 docket not found, 2 entry not found,
///      4 not an order, 8 hash mismatch, 16 wallet not in order, 32 no wallets, 64 date mismatch,
///      128 already expired.
contract OrderRegistry is CREReceiver {
    enum Status {
        None,
        Active,
        Rejected,
        Dissolved,
        Expired,
        Superseded
    }

    enum OrderType {
        Other,
        TRO,
        PreliminaryInjunction,
        AssetFreeze,
        Judgment
    }

    enum Action {
        None,
        Attest,
        Reject,
        UpdateStatus
    }

    struct Order {
        /// @dev "<court>|<docketNumber>", e.g. "cand|5:26-cv-05055".
        string docketRef;
        uint32 entryNumber;
        bytes20 docSha1;
        OrderType orderType;
        Status status;
        bool exParte;
        uint64 issuedAt;
        /// @dev 0 = "until further order of the court" (no automatic expiry).
        uint64 expiresAt;
        /// @dev Highest docket entry the sweep workflow has already reviewed.
        uint32 lastCheckedEntry;
        uint32 evidenceEntry;
        bytes20 evidenceSha1;
        address[] wallets;
    }

    /// @dev Report payload for Action.Attest and Action.Reject.
    struct AttestReport {
        bytes32 id;
        string docketRef;
        uint32 entryNumber;
        bytes20 docSha1;
        OrderType orderType;
        bool exParte;
        uint64 issuedAt;
        uint64 expiresAt;
        uint32 reasons;
        address[] wallets;
    }

    /// @dev Report payload for Action.UpdateStatus. newStatus == Active is a checkpoint (only
    ///      lastCheckedEntry advances) or, with a different newExpiresAt, an extension.
    struct StatusReport {
        bytes32 id;
        Status newStatus;
        uint64 newExpiresAt;
        uint32 evidenceEntry;
        bytes20 evidenceSha1;
        uint32 lastCheckedEntry;
    }

    mapping(bytes32 => Order) private s_orders;
    bytes32[] private s_orderIds;
    mapping(address => bytes32[]) private s_ordersByWallet;
    mapping(bytes32 => uint32) public rejections;
    uint256 public rejectionCount;

    event OrderVerified(
        bytes32 indexed id, string docketRef, uint32 entryNumber, bytes20 docSha1, uint64 expiresAt, address[] wallets
    );
    event OrderRejected(
        bytes32 indexed submissionId, string docketRef, uint32 entryNumber, bytes20 submittedSha1, uint32 reasons
    );
    event OrderStatusChanged(bytes32 indexed id, Status current, uint32 evidenceEntry, bytes20 evidenceSha1);
    event OrderExtended(bytes32 indexed id, uint64 newExpiresAt, uint32 evidenceEntry);
    event DocketCheckpoint(bytes32 indexed id, uint32 lastCheckedEntry);
    event HumanOverride(bytes32 indexed id, Status current, string note);

    error UnknownAction(uint8 action);
    error OrderAlreadyRecorded(bytes32 id);
    error OrderNotActive(bytes32 id);
    error InvalidStatus(Status status);
    error NoWallets();

    constructor(address forwarder_) CREReceiver(forwarder_) {}

    // ------------------------------------------------------------------
    // CRE report entrypoint
    // ------------------------------------------------------------------

    function _processReport(bytes calldata report) internal override {
        (uint8 action, bytes memory data) = abi.decode(report, (uint8, bytes));
        if (action == uint8(Action.Attest)) {
            _attest(abi.decode(data, (AttestReport)));
        } else if (action == uint8(Action.Reject)) {
            AttestReport memory r = abi.decode(data, (AttestReport));
            rejections[r.id] = r.reasons;
            ++rejectionCount;
            emit OrderRejected(r.id, r.docketRef, r.entryNumber, r.docSha1, r.reasons);
        } else if (action == uint8(Action.UpdateStatus)) {
            _updateStatus(abi.decode(data, (StatusReport)));
        } else {
            revert UnknownAction(action);
        }
    }

    function _attest(AttestReport memory r) internal {
        Order storage o = s_orders[r.id];
        if (o.status != Status.None) revert OrderAlreadyRecorded(r.id);
        if (r.wallets.length == 0) revert NoWallets();

        o.docketRef = r.docketRef;
        o.entryNumber = r.entryNumber;
        o.docSha1 = r.docSha1;
        o.orderType = r.orderType;
        o.status = Status.Active;
        o.exParte = r.exParte;
        o.issuedAt = r.issuedAt;
        o.expiresAt = r.expiresAt;
        o.lastCheckedEntry = r.entryNumber;
        o.wallets = r.wallets;

        s_orderIds.push(r.id);
        for (uint256 i; i < r.wallets.length; ++i) {
            s_ordersByWallet[r.wallets[i]].push(r.id);
        }
        emit OrderVerified(r.id, r.docketRef, r.entryNumber, r.docSha1, r.expiresAt, r.wallets);
    }

    function _updateStatus(StatusReport memory r) internal {
        Order storage o = s_orders[r.id];
        if (o.status != Status.Active) revert OrderNotActive(r.id);

        if (r.lastCheckedEntry > o.lastCheckedEntry) {
            o.lastCheckedEntry = r.lastCheckedEntry;
            emit DocketCheckpoint(r.id, r.lastCheckedEntry);
        }

        if (r.newStatus == Status.Active) {
            if (r.newExpiresAt != o.expiresAt) {
                o.expiresAt = r.newExpiresAt;
                o.evidenceEntry = r.evidenceEntry;
                o.evidenceSha1 = r.evidenceSha1;
                emit OrderExtended(r.id, r.newExpiresAt, r.evidenceEntry);
            }
            return;
        }
        if (r.newStatus == Status.None || r.newStatus == Status.Rejected) revert InvalidStatus(r.newStatus);

        o.status = r.newStatus;
        o.evidenceEntry = r.evidenceEntry;
        o.evidenceSha1 = r.evidenceSha1;
        emit OrderStatusChanged(r.id, r.newStatus, r.evidenceEntry, r.evidenceSha1);
    }

    // ------------------------------------------------------------------
    // Human override (issuer compliance)
    // ------------------------------------------------------------------

    /// @notice Lets the issuer's compliance owner correct an order's status, e.g. when counsel
    ///         produces a sealed order the public docket cannot show. Always leaves an audit event.
    function overrideStatus(bytes32 id, Status newStatus, string calldata note) external onlyOwner {
        Order storage o = s_orders[id];
        if (o.status == Status.None) revert OrderNotActive(id);
        if (newStatus == Status.None || newStatus == Status.Rejected) revert InvalidStatus(newStatus);
        o.status = newStatus;
        emit HumanOverride(id, newStatus, note);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice True while at least one Active, unexpired order names `wallet`.
    function isFrozen(address wallet) external view returns (bool) {
        bytes32[] storage ids = s_ordersByWallet[wallet];
        for (uint256 i; i < ids.length; ++i) {
            if (isInForce(ids[i])) return true;
        }
        return false;
    }

    /// @notice An order is in force when Active and either open-ended or not yet past expiresAt.
    function isInForce(bytes32 id) public view returns (bool) {
        Order storage o = s_orders[id];
        return o.status == Status.Active && (o.expiresAt == 0 || block.timestamp < o.expiresAt);
    }

    function getOrder(bytes32 id) external view returns (Order memory) {
        return s_orders[id];
    }

    function getOrderIds() external view returns (bytes32[] memory) {
        return s_orderIds;
    }

    function ordersForWallet(address wallet) external view returns (bytes32[] memory) {
        return s_ordersByWallet[wallet];
    }
}
