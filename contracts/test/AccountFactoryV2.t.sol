// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {AccountFactoryV2} from "../src/AccountFactoryV2.sol";

contract FactoryImplementation {
    uint256 public value;

    function initialize(uint256 value_) external {
        require(value == 0, "already initialized");
        value = value_;
    }
}

/// @notice Focused branch-coverage tests for the factory constructor guard.
///         createAccount's deploy vs. idempotent branches are exercised in
///         AccountWebAuthnV2.t.sol; here we close the constructor's revert path
///         (impl must be a contract), which no other test hits.
contract AccountFactoryV2Test is Test {
    event AccountCreated(address indexed account, bytes32 indexed salt);

    function test_constructor_acceptsContractImplementation() public {
        // address(this) is a deployed contract → code.length > 0 → require passes.
        AccountFactoryV2 factory = new AccountFactoryV2(address(this));
        assertEq(factory.IMPLEMENTATION(), address(this));
    }

    function test_constructor_revertsOnNonContractImplementation() public {
        // An address with no code is not a valid proxy implementation.
        vm.expectRevert(AccountFactoryV2.InvalidImplementation.selector);
        new AccountFactoryV2(address(0xdead));
    }

    function test_constructor_revertsOnZeroImplementation() public {
        vm.expectRevert(AccountFactoryV2.InvalidImplementation.selector);
        new AccountFactoryV2(address(0));
    }

    function test_createAccount_deploysAtPredictedAddress() public {
        FactoryImplementation implementation = new FactoryImplementation();
        AccountFactoryV2 factory = new AccountFactoryV2(address(implementation));
        bytes memory initData = abi.encodeCall(FactoryImplementation.initialize, (42));
        address predicted = factory.predictAddress(initData);

        vm.expectEmit(true, true, false, false, address(factory));
        emit AccountCreated(predicted, keccak256(initData));
        address created = factory.createAccount(initData);

        assertEq(created, predicted);
        assertGt(created.code.length, 0);
        assertEq(FactoryImplementation(created).value(), 42);
    }

    function test_createAccount_returnsExistingProxyWithoutReinitializing() public {
        FactoryImplementation implementation = new FactoryImplementation();
        AccountFactoryV2 factory = new AccountFactoryV2(address(implementation));
        bytes memory initData = abi.encodeCall(FactoryImplementation.initialize, (42));

        address first = factory.createAccount(initData);
        vm.recordLogs();
        address second = factory.createAccount(initData);

        assertEq(second, first);
        assertEq(vm.getRecordedLogs().length, 0, "idempotent path must not emit another creation event");
        assertEq(FactoryImplementation(second).value(), 42);
    }
}
