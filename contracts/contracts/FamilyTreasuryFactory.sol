// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FamilyTreasury} from "./FamilyTreasury.sol";

/// @notice Creates discoverable, isolated family treasuries for one USDC deployment.
contract FamilyTreasuryFactory {
    IERC20 public immutable asset;
    mapping(bytes32 => address) public treasuryForFamily;
    error InvalidFamily(); error FamilyAlreadyExists();
    event FamilyCreated(bytes32 indexed familyId, address indexed treasury, address indexed creator);

    constructor(IERC20 asset_) { if (address(asset_) == address(0)) revert InvalidFamily(); asset = asset_; }
    function createFamily(bytes32 familyId, address[] calldata parents, FamilyTreasury.VaultConfig[] calldata initialVaults) external returns (address treasury) {
        if (familyId == bytes32(0) || treasuryForFamily[familyId] != address(0)) revert FamilyAlreadyExists();
        bool creatorIsParent;
        for (uint256 i; i < parents.length; ++i) if (parents[i] == msg.sender) creatorIsParent = true;
        if (!creatorIsParent) revert InvalidFamily();
        treasury = address(new FamilyTreasury(asset, parents, initialVaults));
        treasuryForFamily[familyId] = treasury;
        emit FamilyCreated(familyId, treasury, msg.sender);
    }
}
