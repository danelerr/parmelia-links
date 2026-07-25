// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {AccountWebAuthnV2} from "../src/AccountWebAuthnV2.sol";
import {AccountFactoryV2} from "../src/AccountFactoryV2.sol";
import {ERC7913WebAuthnVerifier} from "../src/ERC7913WebAuthnVerifier.sol";

/**
 * @title AccountWebAuthnV2Test
 * @notice Foundry tests for the V2 account system: multi-signer, factory, recovery, and upgradeability.
 *
 * @dev Since WebAuthn and P256 signatures are hard to replicate in Foundry tests,
 *      we test the contract logic at the Solidity level:
 *      - Initialization and signer registration
 *      - Factory deployment and address prediction
 *      - Guardian recovery flow (propose, cancel, execute with timelock)
 *      - Access control (onlyEntryPointOrSelf, onlyGuardian)
 *      - UUPS upgrade authorization
 */
contract AccountWebAuthnV2Test is Test {
    AccountWebAuthnV2 public implementation;
    AccountFactoryV2 public factory;
    ERC7913WebAuthnVerifier public verifier;

    address public guardian = makeAddr("guardian");
    address public attacker = makeAddr("attacker");

    // Dummy P256 public key coordinates (these are the generator point for P256)
    bytes32 constant QX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant QY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;

    // Second dummy key for backup passkey tests
    bytes32 constant QX2 = 0x7CF27B188D034F7E8A52380304B51AC3C90B0BF0D14503AED41B06C14F8B1F3A;
    bytes32 constant QY2 = 0x0E1E20879D5C3DB05F2F8B0E1F7B3A9E3A5D3E7B1C4F6A8D2E0F1B3C5D7E9A0B;

    function setUp() public {
        // Deploy verifier and implementation
        verifier = new ERC7913WebAuthnVerifier();
        implementation = new AccountWebAuthnV2();
        factory = new AccountFactoryV2(address(implementation));
    }

    // ========== Helper Functions ==========

    function _buildSigner(bytes32 qx, bytes32 qy) internal view returns (bytes memory) {
        return abi.encodePacked(address(verifier), qx, qy);
    }

    function _buildInitData(bytes[] memory signers, uint64 threshold, address guardian_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(AccountWebAuthnV2.initialize, (signers, threshold, guardian_));
    }

    function _deploySingleSignerAccount() internal returns (AccountWebAuthnV2 account) {
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);
        bytes memory initData = _buildInitData(signers, 1, guardian);
        address accountAddr = factory.createAccount(initData);
        account = AccountWebAuthnV2(payable(accountAddr));
    }

    // ========== Factory Tests ==========

    function test_factory_createAccount() public {
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);
        bytes memory initData = _buildInitData(signers, 1, guardian);

        address predicted = factory.predictAddress(initData);
        address created = factory.createAccount(initData);

        assertEq(predicted, created, "predicted address should match created");
        assertTrue(created.code.length > 0, "account should have code");
    }

    function test_factory_predictAddress_deterministic() public view {
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);
        bytes memory initData = _buildInitData(signers, 1, guardian);

        address predicted1 = factory.predictAddress(initData);
        address predicted2 = factory.predictAddress(initData);

        assertEq(predicted1, predicted2, "predictions should be deterministic");
    }

    function test_factory_createAccount_idempotent() public {
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);
        bytes memory initData = _buildInitData(signers, 1, guardian);

        address first = factory.createAccount(initData);
        address second = factory.createAccount(initData);

        assertEq(first, second, "should return same address on second call");
    }

    function test_factory_differentSigners_differentAddresses() public {
        bytes[] memory signers1 = new bytes[](1);
        signers1[0] = _buildSigner(QX, QY);
        bytes memory initData1 = _buildInitData(signers1, 1, guardian);

        bytes[] memory signers2 = new bytes[](1);
        signers2[0] = _buildSigner(QX2, QY2);
        bytes memory initData2 = _buildInitData(signers2, 1, guardian);

        address addr1 = factory.createAccount(initData1);
        address addr2 = factory.createAccount(initData2);

        assertTrue(addr1 != addr2, "different signers should produce different addresses");
    }

    // ========== Initialization Tests ==========

    function test_initialize_signerRegistered() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        assertEq(account.getSignerCount(), 1, "should have 1 signer");
        assertTrue(account.isSigner(_buildSigner(QX, QY)), "signer should be registered");
        assertEq(account.threshold(), 1, "threshold should be 1");
    }

    function test_initialize_guardianSet() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        assertEq(account.guardian(), guardian, "guardian should be set");
    }

    function test_initialize_cannotReinitialize() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX2, QY2);

        vm.expectRevert();
        account.initialize(signers, 1, guardian);
    }

    function test_implementation_cannotBeInitialized() public {
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);

        vm.expectRevert();
        implementation.initialize(signers, 1, guardian);
    }

    // ========== Signer Management Access Control Tests ==========

    function test_addSigners_onlyEntryPointOrSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        // Should fail from attacker
        vm.prank(attacker);
        vm.expectRevert();
        account.addSigners(newSigners);
    }

    function test_addSigners_fromSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        // Should succeed from self (simulating a UserOp execution)
        vm.prank(address(account));
        account.addSigners(newSigners);

        assertEq(account.getSignerCount(), 2, "should have 2 signers after adding");
        assertTrue(account.isSigner(_buildSigner(QX2, QY2)), "new signer should be registered");
    }

    function test_removeSigners_fromSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        // First add a second signer
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);
        vm.prank(address(account));
        account.addSigners(newSigners);

        // Now remove the original signer
        bytes[] memory toRemove = new bytes[](1);
        toRemove[0] = _buildSigner(QX, QY);
        vm.prank(address(account));
        account.removeSigners(toRemove);

        assertEq(account.getSignerCount(), 1, "should have 1 signer after removal");
        assertFalse(account.isSigner(_buildSigner(QX, QY)), "old signer should be removed");
        assertTrue(account.isSigner(_buildSigner(QX2, QY2)), "new signer should remain");
    }

    function test_setThreshold_fromSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        // Add a second signer first
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);
        vm.prank(address(account));
        account.addSigners(newSigners);

        // Raise threshold to 2
        vm.prank(address(account));
        account.setThreshold(2);

        assertEq(account.threshold(), 2, "threshold should be 2");
    }

    function test_setGuardian_fromSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        address newGuardian = makeAddr("newGuardian");

        vm.prank(address(account));
        account.setGuardian(newGuardian);

        assertEq(account.guardian(), newGuardian, "guardian should be updated");
    }

    function test_setGuardian_onlyEntryPointOrSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        vm.prank(attacker);
        vm.expectRevert();
        account.setGuardian(attacker);
    }

    // ========== Recovery Flow Tests ==========

    function test_recovery_propose() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        assertTrue(account.isRecoveryPending(), "recovery should be pending");

        (uint256 executeAfter, bytes[] memory pending, uint64 threshold) = account.getPendingRecovery();
        assertEq(executeAfter, block.timestamp + 48 hours, "executeAfter should be 48h from now");
        assertEq(pending.length, 1, "should have 1 pending signer");
        assertEq(threshold, 1, "pending threshold should be 1");
    }

    function test_recovery_onlyGuardianCanPropose() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(attacker);
        vm.expectRevert(AccountWebAuthnV2.OnlyGuardian.selector);
        account.proposeRecovery(newSigners, 1);
    }

    function test_recovery_cannotProposeTwice() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.RecoveryAlreadyProposed.selector);
        account.proposeRecovery(newSigners, 1);
    }

    function test_recovery_cancel() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        // Owner cancels
        vm.prank(address(account));
        account.cancelRecovery();

        assertFalse(account.isRecoveryPending(), "recovery should not be pending after cancel");
    }

    function test_recovery_attackerCannotCancel() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        // Attacker tries to cancel - should fail
        vm.prank(attacker);
        vm.expectRevert();
        account.cancelRecovery();
    }

    function test_recovery_cannotExecuteBeforeTimelock() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        // Try to execute before timelock
        vm.expectRevert(AccountWebAuthnV2.RecoveryNotReady.selector);
        account.executeRecovery();
    }

    function test_recovery_executeAfterTimelock() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        // Warp past the timelock
        vm.warp(block.timestamp + 48 hours + 1);

        account.executeRecovery();

        // Verify new signers
        assertEq(account.getSignerCount(), 1, "should have 1 signer after recovery");
        assertTrue(account.isSigner(_buildSigner(QX2, QY2)), "new signer should be registered");
        assertFalse(account.isSigner(_buildSigner(QX, QY)), "old signer should be removed");
        assertFalse(account.isRecoveryPending(), "recovery should be cleared");
    }

    function test_recovery_canCancelDuringTimelock() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        // Warp halfway through the timelock
        vm.warp(block.timestamp + 24 hours);

        // Owner cancels
        vm.prank(address(account));
        account.cancelRecovery();

        // Original signer still valid
        assertEq(account.getSignerCount(), 1, "should still have 1 signer");
        assertTrue(account.isSigner(_buildSigner(QX, QY)), "original signer should still be there");
    }

    function test_recovery_cannotExecuteWithoutProposal() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        vm.expectRevert(AccountWebAuthnV2.RecoveryNotProposed.selector);
        account.executeRecovery();
    }

    // ========== Recovery Proposal Validation (griefing hardening) ==========
    // A malformed proposal used to be accepted and only revert inside
    // executeRecovery 48h later — for a user who lost their passkey and could
    // not cancel, that bricked recovery permanently.

    function test_recovery_proposeRejectsEmptySigners() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory none = new bytes[](0);

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(none, 1);
    }

    function test_recovery_proposeRejectsZeroThreshold() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(newSigners, 0);
    }

    function test_recovery_proposeRejectsThresholdAboveCount() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(newSigners, 2);
    }

    function test_recovery_proposeRejectsDuplicateSigners() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](2);
        newSigners[0] = _buildSigner(QX2, QY2);
        newSigners[1] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(newSigners, 1);
    }

    function test_recovery_proposeRejectsShortSignerBytes() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = hex"deadbeef"; // < 20 bytes: not a valid ERC-7913 signer

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(newSigners, 1);
    }

    function test_recovery_proposeRejectsOversizedProposal() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](33);
        for (uint256 i = 0; i < 33; i++) {
            newSigners[i] = abi.encodePacked(address(verifier), bytes32(i + 1), bytes32(i + 2));
        }

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.InvalidRecoveryProposal.selector);
        account.proposeRecovery(newSigners, 1);
    }

    function test_recovery_proposeWithoutGuardianRevertsNoGuardianSet() public {
        // Account deployed WITHOUT a guardian: the error must be NoGuardianSet
        // (previously unreachable — OnlyGuardian shadowed it).
        bytes[] memory signers = new bytes[](1);
        signers[0] = _buildSigner(QX, QY);
        bytes memory initData = _buildInitData(signers, 1, address(0));
        AccountWebAuthnV2 account = AccountWebAuthnV2(payable(factory.createAccount(initData)));

        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(attacker);
        vm.expectRevert(AccountWebAuthnV2.NoGuardianSet.selector);
        account.proposeRecovery(newSigners, 1);
    }

    // ========== Guardian Cancel + Guardian Rotation ==========

    function test_recovery_guardianCanCancelOwnProposal() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        vm.prank(guardian);
        account.guardianCancelRecovery();

        assertFalse(account.isRecoveryPending(), "guardian cancel should clear the proposal");

        // Re-propose restarts the FULL timelock (cancel grants no shortcut).
        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);
        (uint256 executeAfter,,) = account.getPendingRecovery();
        assertEq(executeAfter, block.timestamp + 48 hours, "re-propose restarts the 48h clock");
    }

    function test_recovery_attackerCannotGuardianCancel() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);

        vm.prank(attacker);
        vm.expectRevert(AccountWebAuthnV2.OnlyGuardian.selector);
        account.guardianCancelRecovery();
    }

    function test_recovery_guardianCancelRequiresProposal() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        vm.prank(guardian);
        vm.expectRevert(AccountWebAuthnV2.RecoveryNotProposed.selector);
        account.guardianCancelRecovery();
    }

    function test_recovery_setGuardianClearsPendingProposal() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);

        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);
        assertTrue(account.isRecoveryPending());

        // Rotating (or removing) the guardian voids the old guardian's proposal.
        vm.prank(address(account));
        account.setGuardian(makeAddr("newGuardian"));

        assertFalse(account.isRecoveryPending(), "pending recovery must not survive a guardian rotation");

        // Even past the old timelock, nothing is executable.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert(AccountWebAuthnV2.RecoveryNotProposed.selector);
        account.executeRecovery();
    }

    // ========== UUPS Upgrade Tests ==========

    function test_upgrade_onlyEntryPointOrSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        AccountWebAuthnV2 newImpl = new AccountWebAuthnV2();

        // Attacker cannot upgrade
        vm.prank(attacker);
        vm.expectRevert();
        account.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgrade_fromSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();
        AccountWebAuthnV2 newImpl = new AccountWebAuthnV2();

        // Self can upgrade (simulating a signed UserOp execution)
        vm.prank(address(account));
        account.upgradeToAndCall(address(newImpl), "");
    }

    /// Upgrade-path regression (AUDIT M-3): a V3 that only APPENDS storage must
    /// preserve every V2 slot — signers, guardian, and the pending recovery —
    /// and its appended variable must work without clobbering them.
    function test_upgrade_preservesStateWithAppendedStorage() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        // Build meaningful pre-upgrade state, including mid-flight recovery.
        bytes[] memory newSigners = new bytes[](1);
        newSigners[0] = _buildSigner(QX2, QY2);
        vm.prank(guardian);
        account.proposeRecovery(newSigners, 1);
        (uint256 executeAfterBefore,,) = account.getPendingRecovery();

        AccountV3AppendedStorageMock newImpl = new AccountV3AppendedStorageMock();
        vm.prank(address(account));
        account.upgradeToAndCall(address(newImpl), "");

        AccountV3AppendedStorageMock upgraded = AccountV3AppendedStorageMock(payable(address(account)));

        // Every V2 slot survived.
        assertEq(upgraded.guardian(), guardian, "guardian must survive the upgrade");
        assertTrue(upgraded.isSigner(_buildSigner(QX, QY)), "signer set must survive the upgrade");
        assertTrue(upgraded.isRecoveryPending(), "pending recovery must survive the upgrade");
        (uint256 executeAfterAfter, bytes[] memory pending,) = upgraded.getPendingRecovery();
        assertEq(executeAfterAfter, executeAfterBefore, "recovery timelock must survive");
        assertEq(keccak256(pending[0]), keccak256(newSigners[0]), "pending signers must survive");

        // The appended variable works and does not clobber earlier slots.
        vm.prank(address(upgraded));
        upgraded.setNewFeature(42);
        assertEq(upgraded.newFeature(), 42, "appended storage must be writable");
        assertEq(upgraded.guardian(), guardian, "appended writes must not clobber V2 slots");
        assertTrue(upgraded.isRecoveryPending(), "appended writes must not clobber recovery state");
    }

    // ========== ERC7821 Executor Tests ==========

    function test_execute_onlyEntryPointOrSelf() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        bytes32 mode = bytes32(uint256(1) << 248); // CALLTYPE_BATCH
        bytes memory executionData = abi.encode(new bytes[](0));

        vm.prank(attacker);
        vm.expectRevert();
        account.execute(mode, executionData);
    }

    // ========== View Helpers Tests ==========

    function test_getSigners() public {
        AccountWebAuthnV2 account = _deploySingleSignerAccount();

        bytes[] memory signers = account.getSigners(0, type(uint64).max);
        assertEq(signers.length, 1, "should return 1 signer");
        assertEq(keccak256(signers[0]), keccak256(_buildSigner(QX, QY)), "signer should match");
    }
}

/// @dev A future V3 done RIGHT: inherits V2 unchanged so every existing slot
///      keeps its position, and only APPENDS new state after it. Used by the
///      upgrade-path regression test (AUDIT M-3).
contract AccountV3AppendedStorageMock is AccountWebAuthnV2 {
    uint256 public newFeature;

    function setNewFeature(uint256 value) external onlyEntryPointOrSelf {
        newFeature = value;
    }
}
