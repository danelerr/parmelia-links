// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Fail-closed role policy shared by all deployment scripts.
library DeploymentRoles {
    uint256 internal constant ARBITRUM_ONE_CHAIN_ID = 42161;
    address internal constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    bytes32 internal constant DEPLOYER = "deployer";
    bytes32 internal constant OWNER = "owner";
    bytes32 internal constant TREASURY = "treasury";
    bytes32 internal constant PAYMASTER_SIGNER = "paymasterSigner";
    bytes32 internal constant INVOICE_SIGNER = "invoiceSigner";

    error UnsafeBroadcaster(address broadcaster);
    error MissingDeploymentRole(bytes32 role);
    error MainnetRoleCollision(bytes32 firstRole, bytes32 secondRole, address account);

    function validatePaymaster(uint256 chainId, address deployer, address owner, address sponsorSigner) internal pure {
        _validateBroadcaster(deployer);
        _validateAddress(OWNER, owner);
        _validateAddress(PAYMASTER_SIGNER, sponsorSigner);
        if (chainId != ARBITRUM_ONE_CHAIN_ID) return;

        _requireDistinct(DEPLOYER, deployer, OWNER, owner);
        _requireDistinct(DEPLOYER, deployer, PAYMASTER_SIGNER, sponsorSigner);
        _requireDistinct(OWNER, owner, PAYMASTER_SIGNER, sponsorSigner);
    }

    function validatePaymentRouter(
        uint256 chainId,
        address deployer,
        address owner,
        address treasury,
        address invoiceSigner
    ) internal pure {
        _validateBroadcaster(deployer);
        _validateAddress(OWNER, owner);
        _validateAddress(TREASURY, treasury);
        _validateAddress(INVOICE_SIGNER, invoiceSigner);
        if (chainId != ARBITRUM_ONE_CHAIN_ID) return;

        _requireDistinct(DEPLOYER, deployer, OWNER, owner);
        _requireDistinct(DEPLOYER, deployer, TREASURY, treasury);
        _requireDistinct(DEPLOYER, deployer, INVOICE_SIGNER, invoiceSigner);
        _requireDistinct(OWNER, owner, TREASURY, treasury);
        _requireDistinct(OWNER, owner, INVOICE_SIGNER, invoiceSigner);
        _requireDistinct(TREASURY, treasury, INVOICE_SIGNER, invoiceSigner);
    }

    function validateCrosschainRouter(uint256 chainId, address deployer, address owner, address treasury)
        internal
        pure
    {
        _validateBroadcaster(deployer);
        _validateAddress(OWNER, owner);
        _validateAddress(TREASURY, treasury);
        if (chainId != ARBITRUM_ONE_CHAIN_ID) return;

        _requireDistinct(DEPLOYER, deployer, OWNER, owner);
        _requireDistinct(DEPLOYER, deployer, TREASURY, treasury);
        _requireDistinct(OWNER, owner, TREASURY, treasury);
    }

    function _validateBroadcaster(address deployer) private pure {
        if (deployer == address(0) || deployer == FOUNDRY_DEFAULT_SENDER) {
            revert UnsafeBroadcaster(deployer);
        }
    }

    function _validateAddress(bytes32 role, address account) private pure {
        if (account == address(0)) revert MissingDeploymentRole(role);
    }

    function _requireDistinct(bytes32 firstRole, address first, bytes32 secondRole, address second) private pure {
        if (first == second) revert MainnetRoleCollision(firstRole, secondRole, first);
    }
}
