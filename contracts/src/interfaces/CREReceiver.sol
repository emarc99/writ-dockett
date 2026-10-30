// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReceiver} from "./IReceiver.sol";

/// @title CREReceiver
/// @notice Minimal CRE report receiver (subset of Chainlink's ReceiverTemplate): only the configured
///         KeystoneForwarder may deliver reports, optionally pinned to one workflow owner and/or id.
/// @dev Kept lean on purpose: Sepolia's post-Fusaka gas schedule plus the 2^24 per-tx gas cap make
///      ~11 KB of initcode undeployable.
abstract contract CREReceiver is IReceiver, Ownable {
    address public forwarder;
    address public expectedWorkflowOwner;
    bytes32 public expectedWorkflowId;

    error InvalidForwarderAddress();
    error InvalidSender(address sender, address expected);
    error InvalidWorkflowOwner(address received, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);

    event ForwarderUpdated(address forwarder);
    event WorkflowPinned(address owner, bytes32 workflowId);

    constructor(address forwarder_) Ownable(msg.sender) {
        if (forwarder_ == address(0)) revert InvalidForwarderAddress();
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        if (expectedWorkflowOwner != address(0) || expectedWorkflowId != bytes32(0)) {
            // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner[, bytes2 reportId])
            bytes32 workflowId = bytes32(metadata[0:32]);
            address owner_ = address(bytes20(metadata[42:62]));
            if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
                revert InvalidWorkflowId(workflowId, expectedWorkflowId);
            }
            if (expectedWorkflowOwner != address(0) && owner_ != expectedWorkflowOwner) {
                revert InvalidWorkflowOwner(owner_, expectedWorkflowOwner);
            }
        }
        _processReport(report);
    }

    /// @notice Switch from the simulation MockKeystoneForwarder to the production KeystoneForwarder.
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert InvalidForwarderAddress();
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Pin reports to a deployed workflow. Leave unset during simulation: the mock
    ///         forwarder does not supply workflow metadata.
    function pinWorkflow(address owner_, bytes32 workflowId) external onlyOwner {
        expectedWorkflowOwner = owner_;
        expectedWorkflowId = workflowId;
        emit WorkflowPinned(owner_, workflowId);
    }

    function _processReport(bytes calldata report) internal virtual;

    function supportsInterface(bytes4 interfaceId) public pure virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
