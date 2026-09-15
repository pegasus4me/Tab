// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Persistent onchain USDC treasury governed by a family's parent accounts.
/// AI has no privileged role: it can only prepare calls that a parent signs.
contract FamilyTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint32 public constant EXTERNAL_RECIPIENT = type(uint32).max;

    struct VaultConfig {
        string name;
        uint128 floor;
        uint8 withdrawalApprovalsRequired;
    }
    struct Vault {
        string name;
        uint128 balance;
        uint128 floor;
        uint8 withdrawalApprovalsRequired;
    }
    struct WithdrawalProposal {
        uint32 vaultId;
        address recipient;
        uint128 amount;
        uint8 approvals;
        bool executed;
    }
    /// @dev destinationVaultId is EXTERNAL_RECIPIENT when recipient receives USDC directly.
    struct ScheduledTransfer {
        uint32 sourceVaultId;
        uint32 destinationVaultId;
        address recipient;
        uint128 amount;
        uint64 interval;
        uint64 nextExecutionAt;
        uint8 approvals;
        bool active;
    }

    error NotParent(); error InvalidConfiguration(); error InvalidVault(); error InvalidAmount();
    error InsufficientUnallocatedBalance(); error WouldBreachVaultFloor(); error AlreadyApproved();
    error ProposalAlreadyExecuted(); error ScheduleNotActive(); error ScheduleNotDue();

    IERC20 public immutable asset;
    address[] private _parents;
    Vault[] private _vaults;
    WithdrawalProposal[] private _withdrawals;
    ScheduledTransfer[] private _scheduledTransfers;
    mapping(address => bool) public isParent;
    mapping(uint256 => mapping(address => bool)) public hasApprovedWithdrawal;
    mapping(uint256 => mapping(address => bool)) public hasApprovedScheduledTransfer;

    event OwnerAdded(address indexed account, address indexed addedBy);
    event Deposited(address indexed parent, uint256 amount);
    event Allocated(uint256 indexed vaultId, uint256 amount);
    event WithdrawalProposed(uint256 indexed proposalId, uint256 indexed vaultId, address indexed recipient, uint256 amount);
    event WithdrawalApproved(uint256 indexed proposalId, address indexed parent, uint8 approvalCount);
    event WithdrawalExecuted(uint256 indexed proposalId, address indexed recipient, uint256 amount);
    event ScheduledTransferProposed(uint256 indexed scheduleId, uint256 indexed sourceVaultId, uint256 indexed destinationVaultId, address recipient, uint256 amount, uint256 interval);
    event ScheduledTransferApproved(uint256 indexed scheduleId, address indexed parent, uint8 approvalCount);
    event ScheduledTransferExecuted(uint256 indexed scheduleId, uint256 amount, uint256 nextExecutionAt);

    modifier onlyParent() { if (!isParent[msg.sender]) revert NotParent(); _; }

    constructor(IERC20 asset_, address[] memory parents_, VaultConfig[] memory initialVaults_) {
        if (address(asset_) == address(0) || parents_.length == 0 || initialVaults_.length == 0) revert InvalidConfiguration();
        asset = asset_;
        for (uint256 i; i < parents_.length; ++i) {
            address parent = parents_[i];
            if (parent == address(0) || isParent[parent]) revert InvalidConfiguration();
            isParent[parent] = true;
            _parents.push(parent);
        }
        for (uint256 i; i < initialVaults_.length; ++i) _addVault(initialVaults_[i]);
    }

    event VaultCreated(uint256 indexed vaultId, string name);
    function createVault(VaultConfig calldata config) external onlyParent {
        _addVault(config);
        emit VaultCreated(_vaults.length - 1, config.name);
    }

    function parents() external view returns (address[] memory) { return _parents; }
    function addOwner(address account) external onlyParent {
        if (account == address(0) || isParent[account] || _parents.length >= 10) revert InvalidConfiguration();
        isParent[account] = true;
        _parents.push(account);
        emit OwnerAdded(account, msg.sender);
    }
    function vaultCount() external view returns (uint256) { return _vaults.length; }
    function vault(uint256 vaultId) external view returns (Vault memory) { return _vaults[vaultId]; }
    function withdrawalCount() external view returns (uint256) { return _withdrawals.length; }
    function withdrawal(uint256 proposalId) external view returns (WithdrawalProposal memory) { return _withdrawals[proposalId]; }
    function scheduledTransferCount() external view returns (uint256) { return _scheduledTransfers.length; }
    function scheduledTransfer(uint256 scheduleId) external view returns (ScheduledTransfer memory) { return _scheduledTransfers[scheduleId]; }
    function unallocatedBalance() public view returns (uint256) {
        uint256 allocated;
        for (uint256 i; i < _vaults.length; ++i) allocated += _vaults[i].balance;
        return asset.balanceOf(address(this)) - allocated;
    }

    function deposit(uint256 amount) external onlyParent nonReentrant {
        if (amount == 0) revert InvalidAmount();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Atomically applies the confirmed output of an AI allocation plan.
    function allocate(uint256[] calldata vaultIds, uint128[] calldata amounts) external onlyParent {
        if (vaultIds.length == 0 || vaultIds.length != amounts.length) revert InvalidConfiguration();
        uint256 total;
        for (uint256 i; i < vaultIds.length; ++i) {
            if (vaultIds[i] >= _vaults.length || amounts[i] == 0) revert InvalidVault();
            total += amounts[i];
        }
        if (total > unallocatedBalance()) revert InsufficientUnallocatedBalance();
        for (uint256 i; i < vaultIds.length; ++i) {
            _vaults[vaultIds[i]].balance += amounts[i];
            emit Allocated(vaultIds[i], amounts[i]);
        }
    }

    /// @notice Starts a protected external transfer; proposing counts as one approval.
    function proposeWithdrawal(uint32 vaultId, address recipient, uint128 amount) external onlyParent nonReentrant returns (uint256 proposalId) {
        if (vaultId >= _vaults.length || recipient == address(0) || amount == 0) revert InvalidVault();
        Vault storage source = _vaults[vaultId];
        if (source.balance < amount || source.balance - amount < source.floor) revert WouldBreachVaultFloor();
        proposalId = _withdrawals.length;
        _withdrawals.push(WithdrawalProposal(vaultId, recipient, amount, 0, false));
        emit WithdrawalProposed(proposalId, vaultId, recipient, amount);
        _approveWithdrawal(proposalId);
    }
    function approveWithdrawal(uint256 proposalId) external onlyParent nonReentrant { _approveWithdrawal(proposalId); }

    /// @notice Proposes a recurring internal allocation or an external payment.
    /// The source vault's quorum must approve before this schedule becomes active.
    function proposeScheduledTransfer(
        uint32 sourceVaultId, uint32 destinationVaultId, address recipient, uint128 amount,
        uint64 interval, uint64 firstExecutionAt
    ) external onlyParent returns (uint256 scheduleId) {
        if (sourceVaultId >= _vaults.length || amount == 0 || interval == 0 || firstExecutionAt < block.timestamp) revert InvalidConfiguration();
        if (destinationVaultId == EXTERNAL_RECIPIENT) {
            if (recipient == address(0)) revert InvalidConfiguration();
        } else if (destinationVaultId >= _vaults.length || destinationVaultId == sourceVaultId || recipient != address(0)) {
            revert InvalidConfiguration();
        }
        scheduleId = _scheduledTransfers.length;
        _scheduledTransfers.push(ScheduledTransfer(sourceVaultId, destinationVaultId, recipient, amount, interval, firstExecutionAt, 0, false));
        emit ScheduledTransferProposed(scheduleId, sourceVaultId, destinationVaultId, recipient, amount, interval);
        _approveScheduledTransfer(scheduleId);
    }
    function approveScheduledTransfer(uint256 scheduleId) external onlyParent { _approveScheduledTransfer(scheduleId); }

    /// @notice Callable by a relayer, the AI service, or any user. The rule itself fixes all values.
    function executeScheduledTransfer(uint256 scheduleId) external nonReentrant {
        ScheduledTransfer storage schedule = _scheduledTransfers[scheduleId];
        if (!schedule.active) revert ScheduleNotActive();
        if (block.timestamp < schedule.nextExecutionAt) revert ScheduleNotDue();
        Vault storage source = _vaults[schedule.sourceVaultId];
        if (source.balance < schedule.amount || source.balance - schedule.amount < source.floor) revert WouldBreachVaultFloor();
        source.balance -= schedule.amount;
        if (schedule.destinationVaultId == EXTERNAL_RECIPIENT) asset.safeTransfer(schedule.recipient, schedule.amount);
        else _vaults[schedule.destinationVaultId].balance += schedule.amount;
        schedule.nextExecutionAt += schedule.interval;
        emit ScheduledTransferExecuted(scheduleId, schedule.amount, schedule.nextExecutionAt);
    }

    function _addVault(VaultConfig memory config) private {
        if (bytes(config.name).length == 0 || config.withdrawalApprovalsRequired == 0 || config.withdrawalApprovalsRequired > _parents.length) revert InvalidConfiguration();
        _vaults.push(Vault(config.name, 0, config.floor, config.withdrawalApprovalsRequired));
    }
    function _approveWithdrawal(uint256 proposalId) private {
        WithdrawalProposal storage proposal = _withdrawals[proposalId];
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (hasApprovedWithdrawal[proposalId][msg.sender]) revert AlreadyApproved();
        hasApprovedWithdrawal[proposalId][msg.sender] = true;
        proposal.approvals += 1;
        emit WithdrawalApproved(proposalId, msg.sender, proposal.approvals);
        Vault storage source = _vaults[proposal.vaultId];
        if (proposal.approvals >= source.withdrawalApprovalsRequired) {
            if (source.balance < proposal.amount || source.balance - proposal.amount < source.floor) revert WouldBreachVaultFloor();
            proposal.executed = true;
            source.balance -= proposal.amount;
            asset.safeTransfer(proposal.recipient, proposal.amount);
            emit WithdrawalExecuted(proposalId, proposal.recipient, proposal.amount);
        }
    }
    function _approveScheduledTransfer(uint256 scheduleId) private {
        ScheduledTransfer storage schedule = _scheduledTransfers[scheduleId];
        if (hasApprovedScheduledTransfer[scheduleId][msg.sender]) revert AlreadyApproved();
        hasApprovedScheduledTransfer[scheduleId][msg.sender] = true;
        schedule.approvals += 1;
        emit ScheduledTransferApproved(scheduleId, msg.sender, schedule.approvals);
        if (schedule.approvals >= _vaults[schedule.sourceVaultId].withdrawalApprovalsRequired) schedule.active = true;
    }
}
