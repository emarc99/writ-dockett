// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OrderRegistry} from "../src/OrderRegistry.sol";
import {WritToken, IFreezeOracle} from "../src/WritToken.sol";
import {CREReceiver} from "../src/interfaces/CREReceiver.sol";

contract WritTest is Test {
    OrderRegistry registry;
    WritToken token;

    address forwarder = makeAddr("forwarder");
    address alice = makeAddr("alice");

    // Wallets named in Newton AC/DC Fund v. Ermilov, 5:26-cv-05055 (N.D. Cal.), ECF 18.
    address constant W1 = 0xf7Fcc767dE537953b3519D4b3097A24A6dFE1c84;
    address constant W2 = 0x898137400867603E6D713CBD40881dd0c79E47cB;
    address constant W5 = 0xe497285e466227F4E8648209E34B465dAA1F90a0;
    address constant ATTACKER = 0x4c1f0B2d9e8a7f6C3B5a49d8e7f60a1B2C3D4e5f;

    string constant COURT = "cand";
    string constant DOCKET = "5:26-cv-05055";
    string constant DOCKET_REF = "cand|5:26-cv-05055";
    bytes20 constant GENUINE_SHA1 = bytes20(hex"ec485c6c5b714a2f1f7c3c365a2835a0e5d7b8bd");
    bytes20 constant FORGED_SHA1 = bytes20(hex"a40c167938d56e15f8959675bb5c7e46dda1bdea");
    bytes20 constant DISSOLVE_SHA1 = bytes20(hex"26009af814db8255e8f3a51d8f709717b8255c0d");

    uint64 constant JUNE_5_2026 = 1780617600;

    function setUp() public {
        vm.warp(JUNE_5_2026 + 1 hours);
        registry = new OrderRegistry(forwarder);
        token = new WritToken(IFreezeOracle(address(registry)));
        token.mint(alice, 1_000e6);
        token.mint(W1, 500e6);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Same derivation as the workflows: keccak256(abi.encode(court, docketNumber, entry)).
    function _id(uint32 entry) internal pure returns (bytes32) {
        return keccak256(abi.encode(COURT, DOCKET, entry));
    }

    function _activeCount() internal view returns (uint256 n) {
        bytes32[] memory ids = registry.getOrderIds();
        for (uint256 i; i < ids.length; ++i) {
            if (registry.getOrder(ids[i]).status == OrderRegistry.Status.Active) ++n;
        }
    }

    function _wallets() internal pure returns (address[] memory w) {
        w = new address[](3);
        w[0] = W1;
        w[1] = W2;
        w[2] = W5;
    }

    function _attestReport(bytes32 id, uint32 entry, bool exParte, uint64 expiresAt, address[] memory wallets)
        internal
        pure
        returns (bytes memory)
    {
        OrderRegistry.AttestReport memory r = OrderRegistry.AttestReport({
            id: id,
            docketRef: DOCKET_REF,
            entryNumber: entry,
            docSha1: GENUINE_SHA1,
            orderType: OrderRegistry.OrderType.TRO,
            exParte: exParte,
            issuedAt: JUNE_5_2026,
            expiresAt: expiresAt,
            reasons: 0,
            wallets: wallets
        });
        return abi.encode(uint8(OrderRegistry.Action.Attest), abi.encode(r));
    }

    function _statusReport(bytes32 id, OrderRegistry.Status s, uint64 newExpiresAt, uint32 entry, bytes20 sha)
        internal
        pure
        returns (bytes memory)
    {
        OrderRegistry.StatusReport memory r = OrderRegistry.StatusReport({
            id: id,
            newStatus: s,
            newExpiresAt: newExpiresAt,
            evidenceEntry: entry,
            evidenceSha1: sha,
            lastCheckedEntry: entry
        });
        return abi.encode(uint8(OrderRegistry.Action.UpdateStatus), abi.encode(r));
    }

    function _deliver(bytes memory report) internal {
        vm.prank(forwarder);
        registry.onReport("", report);
    }

    function _attestConsentTro() internal returns (bytes32 id) {
        id = _id(18);
        _deliver(_attestReport(id, 18, false, 0, _wallets()));
    }

    // ---------------------------------------------------------------- access control

    function test_onlyForwarderCanReport() public {
        bytes32 id = _id(18);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidSender.selector, alice, forwarder));
        vm.prank(alice);
        registry.onReport("", _attestReport(id, 18, false, 0, _wallets()));
    }

    // ---------------------------------------------------------------- genuine order

    function test_verifiedConsentTroFreezesNamedWallets() public {
        bytes32 id = _attestConsentTro();

        assertTrue(registry.isFrozen(W1));
        assertTrue(registry.isFrozen(W5));
        assertFalse(registry.isFrozen(alice));
        assertTrue(registry.isInForce(id));

        OrderRegistry.Order memory o = registry.getOrder(id);
        assertEq(uint8(o.status), uint8(OrderRegistry.Status.Active));
        assertEq(o.expiresAt, 0, "consent TRO runs until further order");
        assertEq(o.docSha1, GENUINE_SHA1);
        assertEq(o.wallets.length, 3);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WritToken.WalletFrozen.selector, W1));
        token.transfer(W1, 1e6);

        vm.prank(W1);
        vm.expectRevert(abi.encodeWithSelector(WritToken.WalletFrozen.selector, W1));
        token.transfer(alice, 1e6);

        // Open-ended order is still in force months later.
        vm.warp(block.timestamp + 120 days);
        assertTrue(registry.isFrozen(W1));
    }

    function test_duplicateAttestationReverts() public {
        bytes32 id = _attestConsentTro();
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(OrderRegistry.OrderAlreadyRecorded.selector, id));
        registry.onReport("", _attestReport(id, 18, false, 0, _wallets()));
    }

    function test_attestWithoutWalletsReverts() public {
        bytes32 id = _id(18);
        vm.prank(forwarder);
        vm.expectRevert(OrderRegistry.NoWallets.selector);
        registry.onReport("", _attestReport(id, 18, false, 0, new address[](0)));
    }

    // ---------------------------------------------------------------- forged order

    function test_forgedOrderIsRecordedButFreezesNothing() public {
        address[] memory claimed = _wallets();
        claimed[2] = ATTACKER;
        bytes32 submissionId = keccak256("forged-submission");
        uint32 reasons = 8 | 16; // hash mismatch | wallet not in order

        OrderRegistry.AttestReport memory r = OrderRegistry.AttestReport({
            id: submissionId,
            docketRef: DOCKET_REF,
            entryNumber: 18,
            docSha1: FORGED_SHA1,
            orderType: OrderRegistry.OrderType.TRO,
            exParte: false,
            issuedAt: JUNE_5_2026,
            expiresAt: 0,
            reasons: reasons,
            wallets: claimed
        });
        _deliver(abi.encode(uint8(OrderRegistry.Action.Reject), abi.encode(r)));

        assertEq(registry.rejections(submissionId), reasons);
        assertEq(registry.rejectionCount(), 1);
        assertEq(registry.getOrderIds().length, 0);
        assertFalse(registry.isFrozen(ATTACKER));
        assertFalse(registry.isFrozen(W1));

        vm.prank(alice);
        token.transfer(ATTACKER, 1e6);
        assertEq(token.balanceOf(ATTACKER), 1e6);
    }

    // ---------------------------------------------------------------- Rule 65(b)(2)

    function test_exParteTroAutoExpiresAfter14DaysWithoutAnyTransaction() public {
        bytes32 id = _id(6);
        uint64 expiresAt = JUNE_5_2026 + 14 days;
        _deliver(_attestReport(id, 6, true, expiresAt, _wallets()));
        assertTrue(registry.isFrozen(W1));

        vm.warp(expiresAt - 1);
        assertTrue(registry.isFrozen(W1));

        vm.warp(expiresAt);
        assertFalse(registry.isFrozen(W1));
        assertFalse(registry.isInForce(id));

        vm.prank(W1);
        token.transfer(alice, 1e6);
    }

    function test_extensionKeepsFreezeAlive() public {
        bytes32 id = _id(6);
        uint64 expiresAt = JUNE_5_2026 + 14 days;
        _deliver(_attestReport(id, 6, true, expiresAt, _wallets()));

        _deliver(_statusReport(id, OrderRegistry.Status.Active, expiresAt + 14 days, 8, DISSOLVE_SHA1));

        vm.warp(expiresAt + 1 days);
        assertTrue(registry.isFrozen(W1));
        OrderRegistry.Order memory o = registry.getOrder(id);
        assertEq(o.expiresAt, expiresAt + 14 days);
        assertEq(o.evidenceEntry, 8);
        assertEq(o.lastCheckedEntry, 8);

        vm.warp(expiresAt + 14 days);
        assertFalse(registry.isFrozen(W1));
    }

    function test_sweepCanMarkTimeExpiredOrder() public {
        bytes32 id = _id(6);
        _deliver(_attestReport(id, 6, true, JUNE_5_2026 + 14 days, _wallets()));
        vm.warp(JUNE_5_2026 + 15 days);

        _deliver(_statusReport(id, OrderRegistry.Status.Expired, 0, 6, bytes20(0)));
        assertEq(uint8(registry.getOrder(id).status), uint8(OrderRegistry.Status.Expired));
        assertEq(_activeCount(), 0);
    }

    // ---------------------------------------------------------------- dissolution

    function test_dissolutionUnfreezesAndRecordsEvidence() public {
        bytes32 id = _attestConsentTro();
        assertEq(_activeCount(), 1);

        _deliver(_statusReport(id, OrderRegistry.Status.Dissolved, 0, 38, DISSOLVE_SHA1));

        assertFalse(registry.isFrozen(W1));
        OrderRegistry.Order memory o = registry.getOrder(id);
        assertEq(uint8(o.status), uint8(OrderRegistry.Status.Dissolved));
        assertEq(o.evidenceEntry, 38);
        assertEq(o.evidenceSha1, DISSOLVE_SHA1);
        assertEq(o.lastCheckedEntry, 38);
        assertEq(_activeCount(), 0);

        vm.prank(alice);
        token.transfer(W1, 1e6);
        vm.prank(W1);
        token.transfer(alice, 1e6);
    }

    function test_cannotUpdateDissolvedOrder() public {
        bytes32 id = _attestConsentTro();
        _deliver(_statusReport(id, OrderRegistry.Status.Dissolved, 0, 38, DISSOLVE_SHA1));

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(OrderRegistry.OrderNotActive.selector, id));
        registry.onReport("", _statusReport(id, OrderRegistry.Status.Active, 0, 40, bytes20(0)));
    }

    function test_unknownOrderUpdateReverts() public {
        bytes32 id = keccak256("nope");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(OrderRegistry.OrderNotActive.selector, id));
        registry.onReport("", _statusReport(id, OrderRegistry.Status.Dissolved, 0, 38, DISSOLVE_SHA1));
    }

    function test_walletStaysFrozenWhileAnotherOrderNamesIt() public {
        bytes32 a = _attestConsentTro();
        address[] memory onlyW1 = new address[](1);
        onlyW1[0] = W1;
        bytes32 b = _id(51);
        _deliver(_attestReport(b, 51, false, 0, onlyW1));

        _deliver(_statusReport(a, OrderRegistry.Status.Dissolved, 0, 38, DISSOLVE_SHA1));
        assertTrue(registry.isFrozen(W1), "still named by order b");
        assertFalse(registry.isFrozen(W2));
        assertEq(registry.ordersForWallet(W1).length, 2);
    }

    // ---------------------------------------------------------------- sweep bookkeeping

    function test_checkpointAdvancesCursorWithoutChangingStatus() public {
        bytes32 id = _attestConsentTro();
        _deliver(_statusReport(id, OrderRegistry.Status.Active, 0, 37, bytes20(0)));

        OrderRegistry.Order memory o = registry.getOrder(id);
        assertEq(o.lastCheckedEntry, 37);
        assertEq(uint8(o.status), uint8(OrderRegistry.Status.Active));
        assertEq(o.evidenceEntry, 0);
        assertTrue(registry.isFrozen(W1));
    }

    function test_unknownActionReverts() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(OrderRegistry.UnknownAction.selector, uint8(9)));
        registry.onReport("", abi.encode(uint8(9), bytes("")));
    }

    // ---------------------------------------------------------------- human override

    function test_ownerOverrideIsAudited() public {
        bytes32 id = _attestConsentTro();
        vm.expectEmit(true, false, false, true);
        emit OrderRegistry.HumanOverride(id, OrderRegistry.Status.Dissolved, "court clerk confirmed dissolution");
        registry.overrideStatus(id, OrderRegistry.Status.Dissolved, "court clerk confirmed dissolution");
        assertFalse(registry.isFrozen(W1));

        vm.prank(alice);
        vm.expectRevert();
        registry.overrideStatus(id, OrderRegistry.Status.Active, "nope");
    }
}
