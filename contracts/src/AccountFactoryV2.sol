// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

/**
 * @title AccountFactoryV2
 * @author Parmelia
 * @notice Factory for deploying UUPS-upgradeable smart accounts (AccountWebAuthnV2).
 *
 * @dev Uses CREATE2 with ERC1967Proxy instead of ERC-1167 Clones.
 *      This enables each wallet to be individually upgradeable via UUPS.
 *
 *      The factory:
 *      1. Computes a deterministic address from the initialization calldata.
 *      2. Deploys an ERC1967Proxy pointing to the AccountWebAuthnV2 implementation.
 *      3. The proxy's constructor calls `initialize(signers, threshold, guardian)`.
 *
 *      Backend integration:
 *      - Call predictAddress(initData) to get the wallet address before deployment.
 *      - Call createAccount(initData) to deploy and initialize.
 *      - initData = abi.encodeCall(AccountWebAuthnV2.initialize, (signers, threshold, guardian))
 */
contract AccountFactoryV2 {
    address public immutable IMPLEMENTATION;

    event AccountCreated(address indexed account, bytes32 indexed salt);

    constructor(address implementation_) {
        require(implementation_.code.length > 0, "AccountFactoryV2: impl must be a contract");
        IMPLEMENTATION = implementation_;
    }

    function _calldataKeccak256(bytes calldata data) private pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            digest := keccak256(ptr, data.length)
        }
    }

    /**
     * @notice Predict the deterministic address for a given initialization payload.
     * @param initData ABI-encoded call to AccountWebAuthnV2.initialize(signers, threshold, guardian).
     * @return The predicted address of the proxy.
     */
    function predictAddress(bytes calldata initData) public view returns (address) {
        bytes32 salt = _calldataKeccak256(initData);
        bytes memory proxyBytecode =
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(IMPLEMENTATION, initData));
        return Create2.computeAddress(salt, keccak256(proxyBytecode));
    }

    /**
     * @notice Deploy a new account proxy, or return the existing one if already deployed.
     * @param initData ABI-encoded call to AccountWebAuthnV2.initialize(signers, threshold, guardian).
     * @return account The address of the deployed (or existing) proxy.
     */
    function createAccount(bytes calldata initData) public returns (address account) {
        address predicted = predictAddress(initData);

        // If already deployed, just return the existing address
        if (predicted.code.length > 0) {
            return predicted;
        }

        bytes32 salt = _calldataKeccak256(initData);
        account = address(new ERC1967Proxy{salt: salt}(IMPLEMENTATION, initData));

        emit AccountCreated(account, salt);
    }
}
