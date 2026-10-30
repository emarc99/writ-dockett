// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/// @title OrderRegistry
/// @notice On-chain record of court orders verified (or rejected) by the Writ CRE workflows.
///         A wallet is frozen only while an Active order names it and that order has not expired.
///         Expiry is evaluated against block.timestamp at read time, so a 14-day ex parte TRO
///         stops freezing wallets on day 15 even if no transaction is ever sent.
contract OrderRegistry is ReceiverTemplate {
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

    /// @dev Reason bits written by the verify workflow when a submission is rejected.
    uint32 public constant R_DOCKET_NOT_FOUND = 1 << 0;
    uint32 public constant R_ENTRY_NOT_FOUND = 1 << 1;
    uint32 public constant R_NOT_AN_ORDER = 1 << 2;
    uint32 public constant R_HASH_MISMATCH = 1 << 3;
    uint32 public constant R_WALLET_NOT_IN_ORDER = 1 << 4;
    uint32 public constant R_NO_WALLETS = 1 << 5;
    uint32 public constant R_DATE_MISMATCH = 1 << 6;
    uint32 public constant R_ALREADY_EXPIRED = 1 << 7;

    struct Order {
        string court;
        string docketNumber;
        uint32 entryNumber;
        bytes20 docSha1;
        OrderType orderType;
        Status status;
        bool exParte;
        uint64 issuedAt;
        /// @dev 0 = "until further order of the court" (no automatic expiry).
        uint64 expiresAt;
        uint64 attestedAt;
        /// @dev Highest docket entry the sweep workflow has already reviewed.
        uint32 lastCheckedEntry;
        uint32 evidenceEntry;
        bytes20 evidenceSha1;
        address[] wallets;
    }

    /// @dev Report payload for Action.Attest and Action.Reject.
    struct AttestReport {
        bytes32 id;
        string court;
        string docketNumber;
        uint32 entryNumber;
        bytes20 docSha1;
        OrderType orderType;
        bool exParte;
        uint64 issuedAt;
        uint64 expiresAt;
        uint32 reasons;
        address[] wallets;
    }

    /// @dev Report payload for Action.UpdateStatus. newStatus == current status is a checkpoint
    ///      (only lastCheckedEntry advances); Active with a later expiresAt is an extension.
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
        bytes32 indexed id,
        string court,
        string docketNumber,
        uint32 entryNumber,
        bytes20 docSha1,
        OrderType orderType,
        uint64 issuedAt,
        uint64 expiresAt,
        address[] wallets
    );
    event OrderRejected(
        bytes32 indexed submissionId,
        string court,
        string docketNumber,
        uint32 entryNumber,
        bytes20 submittedSha1,
        uint32 reasons,
        address[] claimedWallets
    );
    event OrderStatusChanged(
        bytes32 indexed id, Status previous, Status current, uint32 evidenceEntry, bytes20 evidenceSha1
    );
    event OrderExtended(bytes32 indexed id, uint64 previousExpiresAt, uint64 newExpiresAt, uint32 evidenceEntry);
    event DocketCheckpoint(bytes32 indexed id, uint32 lastCheckedEntry);
    event HumanOverride(bytes32 indexed id, Status previous, Status current, string note);

    error UnknownAction(uint8 action);
    error OrderAlreadyRecorded(bytes32 id);
    error UnknownOrder(bytes32 id);
    error OrderNotActive(bytes32 id);
    error InvalidStatusTransition(Status from, Status to);
    error NoWallets();

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    // ------------------------------------------------------------------
    // CRE report entrypoint
    // ------------------------------------------------------------------

    function _processReport(bytes calldata report) internal override {
        (uint8 action, bytes memory data) = abi.decode(report, (uint8, bytes));
        if (action == uint8(Action.Attest)) {
            _attest(abi.decode(data, (AttestReport)));
        } else if (action == uint8(Action.Reject)) {
            _reject(abi.decode(data, (AttestReport)));
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

        o.court = r.court;
        o.docketNumber = r.docketNumber;
        o.entryNumber = r.entryNumber;
        o.docSha1 = r.docSha1;
        o.orderType = r.orderType;
        o.status = Status.Active;
        o.exParte = r.exParte;
        o.issuedAt = r.issuedAt;
        o.expiresAt = r.expiresAt;
        o.attestedAt = uint64(block.timestamp);
        o.lastCheckedEntry = r.entryNumber;
        o.wallets = r.wallets;

        s_orderIds.push(r.id);
        for (uint256 i; i < r.wallets.length; ++i) {
            s_ordersByWallet[r.wallets[i]].push(r.id);
        }

        emit OrderVerified(
            r.id, r.court, r.docketNumber, r.entryNumber, r.docSha1, r.orderType, r.issuedAt, r.expiresAt, r.wallets
        );
    }

    function _reject(AttestReport memory r) internal {
        rejections[r.id] = r.reasons;
        ++rejectionCount;
        emit OrderRejected(r.id, r.court, r.docketNumber, r.entryNumber, r.docSha1, r.reasons, r.wallets);
    }

    function _updateStatus(StatusReport memory r) internal {
        Order storage o = s_orders[r.id];
        if (o.status == Status.None) revert UnknownOrder(r.id);
        if (o.status != Status.Active) revert OrderNotActive(r.id);

        if (r.lastCheckedEntry > o.lastCheckedEntry) {
            o.lastCheckedEntry = r.lastCheckedEntry;
            emit DocketCheckpoint(r.id, r.lastCheckedEntry);
        }

        if (r.newStatus == Status.Active) {
            if (r.newExpiresAt != o.expiresAt) {
                emit OrderExtended(r.id, o.expiresAt, r.newExpiresAt, r.evidenceEntry);
                o.expiresAt = r.newExpiresAt;
                o.evidenceEntry = r.evidenceEntry;
                o.evidenceSha1 = r.evidenceSha1;
            }
            return;
        }

        if (r.newStatus == Status.None || r.newStatus == Status.Rejected) {
            revert InvalidStatusTransition(o.status, r.newStatus);
        }

        Status previous = o.status;
        o.status = r.newStatus;
        o.evidenceEntry = r.evidenceEntry;
        o.evidenceSha1 = r.evidenceSha1;
        emit OrderStatusChanged(r.id, previous, r.newStatus, r.evidenceEntry, r.evidenceSha1);
    }

    // ------------------------------------------------------------------
    // Human override (issuer compliance / court-appointed officer)
    // ------------------------------------------------------------------

    /// @notice Lets the issuer's compliance owner correct an order's status, e.g. when counsel
    ///         produces a sealed order the public docket cannot show. Always leaves an audit event.
    function overrideStatus(bytes32 id, Status newStatus, string calldata note) external onlyOwner {
        Order storage o = s_orders[id];
        if (o.status == Status.None) revert UnknownOrder(id);
        if (newStatus == Status.None || newStatus == Status.Rejected) {
            revert InvalidStatusTransition(o.status, newStatus);
        }
        Status previous = o.status;
        o.status = newStatus;
        emit HumanOverride(id, previous, newStatus, note);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice True while at least one Active, unexpired order names `wallet`.
    function isFrozen(address wallet) public view returns (bool) {
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

    function orderCount() external view returns (uint256) {
        return s_orderIds.length;
    }

    /// @notice Orders the sweep workflow should re-check (Active, including time-expired ones
    ///         that have not yet been marked Expired on-chain).
    function getActiveOrderIds() external view returns (bytes32[] memory active) {
        uint256 n;
        for (uint256 i; i < s_orderIds.length; ++i) {
            if (s_orders[s_orderIds[i]].status == Status.Active) ++n;
        }
        active = new bytes32[](n);
        n = 0;
        for (uint256 i; i < s_orderIds.length; ++i) {
            if (s_orders[s_orderIds[i]].status == Status.Active) active[n++] = s_orderIds[i];
        }
    }

    function ordersForWallet(address wallet) external view returns (bytes32[] memory) {
        return s_ordersByWallet[wallet];
    }

    /// @notice Canonical id for a docket entry; the workflow computes the same value off-chain.
    function orderIdFor(string calldata court, string calldata docketNumber, uint32 entryNumber)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(court, docketNumber, entryNumber));
    }
}
