// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds fixed-price participant contributions until an activity is funded or fails.
contract ActivityEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum FundingState { Collecting, Ready, Funded, Failed, Cancelled }

    struct Place {
        address owner;
        uint64 offerNonce;
        bool refunded;
    }

    bytes32 public constant REPLACEMENT_OFFER_TYPEHASH = keccak256(
        "ReplacementOffer(uint256 placeId,address owner,uint256 price,uint256 expiry,uint256 nonce,address designatedBuyer)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("Count Me In Activity");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private immutable _domainSeparator;

    IERC20 public immutable asset;
    address public immutable organizer;
    address public immutable recipient;
    uint256 public immutable contribution;
    uint256 public immutable capacity;
    uint64 public immutable fundingDeadline;
    uint64 public immutable activityStart;
    uint64 public immutable replacementCutoff;
    bytes32 public immutable termsHash;

    FundingState public state;
    uint256 public placeCount;
    mapping(uint256 => Place) public places;
    mapping(address => bool) public hasActivePlace;

    error InvalidConfiguration();
    error InvalidState();
    error FundingClosed();
    error CapacityReached();
    error AlreadyParticipating();
    error NotOrganizer();
    error NotPlaceOwner();
    error NotRefundable();
    error AlreadyRefunded();
    error ReplacementClosed();
    error InvalidOffer();

    event Joined(uint256 indexed placeId, address indexed participant, uint256 amount);
    event Ready(uint256 participantCount, uint256 totalAmount);
    event Settled(address indexed recipient, uint256 amount);
    event Expired();
    event Cancelled();
    event Refunded(uint256 indexed placeId, address indexed participant, uint256 amount);
    event Replaced(uint256 indexed placeId, address indexed previousOwner, address indexed newOwner, uint256 amount);
    event OfferInvalidated(uint256 indexed placeId, uint256 newNonce);

    constructor(
        IERC20 asset_,
        address organizer_,
        address recipient_,
        uint256 contribution_,
        uint256 capacity_,
        uint64 fundingDeadline_,
        uint64 activityStart_,
        uint64 replacementCutoff_,
        bytes32 termsHash_
    ) {
        if (
            address(asset_) == address(0) || organizer_ == address(0) || recipient_ == address(0)
                || contribution_ == 0 || capacity_ == 0 || capacity_ > 1_000
                || fundingDeadline_ >= activityStart_ || replacementCutoff_ > activityStart_
                || termsHash_ == bytes32(0)
        ) revert InvalidConfiguration();
        asset = asset_;
        organizer = organizer_;
        recipient = recipient_;
        contribution = contribution_;
        capacity = capacity_;
        fundingDeadline = fundingDeadline_;
        activityStart = activityStart_;
        replacementCutoff = replacementCutoff_;
        termsHash = termsHash_;
        _domainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
    }

    function join() external nonReentrant returns (uint256 placeId) {
        if (state != FundingState.Collecting) revert InvalidState();
        if (block.timestamp >= fundingDeadline) revert FundingClosed();
        if (placeCount >= capacity) revert CapacityReached();
        if (hasActivePlace[msg.sender]) revert AlreadyParticipating();

        placeId = placeCount++;
        places[placeId] = Place(msg.sender, 0, false);
        hasActivePlace[msg.sender] = true;
        asset.safeTransferFrom(msg.sender, address(this), contribution);
        emit Joined(placeId, msg.sender, contribution);

        if (placeCount == capacity) {
            state = FundingState.Ready;
            emit Ready(placeCount, contribution * capacity);
        }
    }

    function settle() external nonReentrant {
        if (state != FundingState.Ready) revert InvalidState();
        state = FundingState.Funded;
        uint256 amount = contribution * capacity;
        asset.safeTransfer(recipient, amount);
        emit Settled(recipient, amount);
    }

    function expire() external {
        if (state != FundingState.Collecting || block.timestamp < fundingDeadline) revert InvalidState();
        state = FundingState.Failed;
        emit Expired();
    }

    function cancel() external {
        if (msg.sender != organizer) revert NotOrganizer();
        if (state != FundingState.Collecting) revert InvalidState();
        state = FundingState.Cancelled;
        emit Cancelled();
    }

    function refund(uint256 placeId) external nonReentrant {
        if (state != FundingState.Failed && state != FundingState.Cancelled) revert NotRefundable();
        Place storage place = places[placeId];
        if (place.owner == address(0)) revert NotRefundable();
        if (place.refunded) revert AlreadyRefunded();
        place.refunded = true;
        hasActivePlace[place.owner] = false;
        asset.safeTransfer(place.owner, contribution);
        emit Refunded(placeId, place.owner, contribution);
    }

    function replace(
        uint256 placeId,
        uint256 expiry,
        uint256 nonce,
        address designatedBuyer,
        bytes calldata signature
    ) external nonReentrant {
        if (!_replacementAllowed()) revert ReplacementClosed();
        Place storage place = places[placeId];
        address previousOwner = place.owner;
        if (previousOwner == address(0) || place.refunded) revert InvalidOffer();
        if (hasActivePlace[msg.sender]) revert AlreadyParticipating();
        if (block.timestamp > expiry || nonce != place.offerNonce) revert InvalidOffer();
        if (designatedBuyer != address(0) && designatedBuyer != msg.sender) revert InvalidOffer();

        bytes32 structHash = keccak256(abi.encode(
            REPLACEMENT_OFFER_TYPEHASH,
            placeId,
            previousOwner,
            contribution,
            expiry,
            nonce,
            designatedBuyer
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        if (_recover(digest, signature) != previousOwner) revert InvalidOffer();

        place.owner = msg.sender;
        place.offerNonce += 1;
        hasActivePlace[previousOwner] = false;
        hasActivePlace[msg.sender] = true;
        asset.safeTransferFrom(msg.sender, previousOwner, contribution);
        emit Replaced(placeId, previousOwner, msg.sender, contribution);
    }

    function invalidateOffer(uint256 placeId) external {
        Place storage place = places[placeId];
        if (place.owner != msg.sender || place.refunded) revert NotPlaceOwner();
        place.offerNonce += 1;
        emit OfferInvalidated(placeId, place.offerNonce);
    }

    function _replacementAllowed() private view returns (bool) {
        if (state == FundingState.Collecting) return block.timestamp < fundingDeadline;
        return (state == FundingState.Ready || state == FundingState.Funded) && block.timestamp < replacementCutoff;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidOffer();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) revert InvalidOffer();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidOffer();
    }
}
