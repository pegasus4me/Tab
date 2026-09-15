// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivityEscrow} from "./ActivityEscrow.sol";

/// @notice Deploys one discoverable activity escrow for a supported settlement token.
contract ActivityEscrowFactory {
    IERC20 public immutable asset;
    mapping(bytes32 => address) public escrowForActivity;

    error InvalidActivity();
    error ActivityAlreadyExists();

    event ActivityCreated(bytes32 indexed activityId, address indexed escrow, address indexed organizer);

    constructor(IERC20 asset_) {
        if (address(asset_) == address(0)) revert InvalidActivity();
        asset = asset_;
    }

    function createActivity(
        bytes32 activityId,
        address recipient,
        uint256 contribution,
        uint256 capacity,
        uint64 fundingDeadline,
        uint64 activityStart,
        uint64 replacementCutoff,
        bytes32 termsHash
    ) external returns (address escrow) {
        if (activityId == bytes32(0)) revert InvalidActivity();
        if (escrowForActivity[activityId] != address(0)) revert ActivityAlreadyExists();
        escrow = address(new ActivityEscrow(
            asset,
            msg.sender,
            recipient,
            contribution,
            capacity,
            fundingDeadline,
            activityStart,
            replacementCutoff,
            termsHash
        ));
        escrowForActivity[activityId] = escrow;
        emit ActivityCreated(activityId, escrow, msg.sender);
    }
}
