pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AssetMgmtFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidInput();
    error ReplayDetected();
    error StateMismatch();
    error DecryptionFailed();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Fund {
        euint32 totalAssets;
        euint32 managerFeeRate; // e.g., 1% = 1, 0.5% = 0.5. Scaled by 1000 for euint32.
        euint32 performanceFeeRate; // Scaled by 1000.
        euint32 highWaterMark;
    }
    mapping(uint256 => Fund) public funds; // batchId => Fund
    mapping(uint256 => euint32) public fundValuesAtBatchClose; // batchId => fund value snapshot

    uint256 public currentBatchId;
    bool public batchOpen;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsSet(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, bytes32 encryptedValueSnapshot);
    event FundStateSubmitted(uint256 indexed batchId, address indexed provider, euint32 totalAssets, euint32 managerFee, euint32 performanceFee);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalAssets, uint256 managerFee, uint256 performanceFee, uint256 highWaterMark, uint256 valueAtBatchClose);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default 1 minute cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidInput();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == owner) revert InvalidInput(); // Owner cannot be removed as provider this way
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) {
            currentBatchId++;
        }
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        // Store encrypted value snapshot for this batch
        // This is an example, the actual value might be computed differently
        euint32 snapshotValue = funds[currentBatchId].totalAssets;
        fundValuesAtBatchClose[currentBatchId] = snapshotValue;
        emit BatchClosed(currentBatchId, FHE.toBytes32(snapshotValue));
    }

    function _initIfNeeded(euint32 storage item, uint32 plainValue) internal {
        if (!item.isInitialized()) {
            item = FHE.asEuint32(plainValue);
        }
    }

    function submitFundState(
        euint32 _totalAssets,
        euint32 _managerFeeRate,
        euint32 _performanceFeeRate
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!_totalAssets.isInitialized() || !_managerFeeRate.isInitialized() || !_performanceFeeRate.isInitialized()) {
            revert InvalidInput();
        }
        if (!batchOpen) revert BatchNotOpen();

        Fund storage fund = funds[currentBatchId];
        _initIfNeeded(fund.totalAssets, 0);
        _initIfNeeded(fund.managerFeeRate, 0);
        _initIfNeeded(fund.performanceFeeRate, 0);
        _initIfNeeded(fund.highWaterMark, 0);

        fund.totalAssets = fund.totalAssets.add(_totalAssets);
        fund.managerFeeRate = _managerFeeRate; // Assuming fee rates are set, not aggregated
        fund.performanceFeeRate = _performanceFeeRate; // Assuming fee rates are set, not aggregated

        // Example: Update high water mark if current total assets exceed it
        ebool isHigher = _totalAssets.ge(fund.highWaterMark);
        fund.highWaterMark = fund.highWaterMark.select(_totalAssets, fund.highWaterMark, isHigher);

        emit FundStateSubmitted(currentBatchId, msg.sender, _totalAssets, _managerFeeRate, _performanceFeeRate);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function requestFundDecryption(uint256 _batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        Fund storage fund = funds[_batchId];
        if (!_batchId.isInitialized() || !fund.totalAssets.isInitialized()) revert InvalidInput(); // Basic check

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](5);
        cts[0] = FHE.toBytes32(fund.totalAssets);
        cts[1] = FHE.toBytes32(fund.managerFeeRate);
        cts[2] = FHE.toBytes32(fund.performanceFeeRate);
        cts[3] = FHE.toBytes32(fund.highWaterMark);
        cts[4] = FHE.toBytes32(fundValuesAtBatchClose[_batchId]);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, _batchId, stateHash);
    }

    // 5. Implement Callback
    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayDetected();

        // b. State Verification
        Fund storage fund = funds[ctx.batchId];
        bytes32[] memory currentCts = new bytes32[](5);
        currentCts[0] = FHE.toBytes32(fund.totalAssets);
        currentCts[1] = FHE.toBytes32(fund.managerFeeRate);
        currentCts[2] = FHE.toBytes32(fund.performanceFeeRate);
        currentCts[3] = FHE.toBytes32(fund.highWaterMark);
        currentCts[4] = FHE.toBytes32(fundValuesAtBatchClose[ctx.batchId]);

        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }
        // Security: State hash verification ensures that the contract's state related to the
        // ciphertexts being decrypted hasn't changed since the decryption was requested.
        // This prevents scenarios where an attacker might try to alter data after a request
        // but before decryption, leading to inconsistent or maliciously manipulated results.

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        // d. Decode & Finalize
        // Cleartexts are expected in the same order as cts: totalAssets, managerFeeRate, performanceFeeRate, highWaterMark, valueAtBatchClose
        uint256 totalAssets = abi.decode(cleartexts[0:32], (uint32));
        uint256 managerFeeRate = abi.decode(cleartexts[32:64], (uint32));
        uint256 performanceFeeRate = abi.decode(cleartexts[64:96], (uint32));
        uint256 highWaterMark = abi.decode(cleartexts[96:128], (uint32));
        uint256 valueAtBatchClose = abi.decode(cleartexts[128:160], (uint32));

        ctx.processed = true;
        // Security: Replay protection (ctx.processed) ensures that a successful decryption callback
        // for a given requestId cannot be re-executed, even if an attacker were to somehow
        // replay the transaction or if the FHEVM network had an issue causing a re-broadcast.
        // This is crucial for state consistency and preventing double-spending or double-processing of results.

        emit DecryptionCompleted(requestId, ctx.batchId, totalAssets, managerFeeRate, performanceFeeRate, highWaterMark, valueAtBatchClose);
    }
}