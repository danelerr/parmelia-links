// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {
    ERC7913WebAuthnVerifier as OZWebAuthnVerifier
} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";

/**
 * @title ERC7913WebAuthnVerifier
 * @notice Stateless verifier for WebAuthn (P256) signatures using ERC-7913.
 * @dev Deploy once per chain. Each passkey is registered in MultiSignerERC7913 as:
 *      abi.encodePacked(verifierAddress, qx, qy) - 84 bytes total.
 *      The verifier validates the WebAuthn assertion using the P256 public key
 *      embedded in the signer bytes.
 */
contract ERC7913WebAuthnVerifier is OZWebAuthnVerifier {}
