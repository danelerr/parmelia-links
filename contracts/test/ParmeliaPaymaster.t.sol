// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ParmeliaPaymaster} from "../src/ParmeliaPaymaster.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract ParmeliaPaymasterTest is Test {
    ParmeliaPaymaster internal paymaster;
    address internal constant ENTRY_POINT = address(0xEE);

    uint256 internal sponsorPk = 0xA11CE;
    address internal sponsor;

    uint128 internal constant VER_GAS = 100000;
    uint128 internal constant POSTOP_GAS = 50000;

    function setUp() public {
        sponsor = vm.addr(sponsorPk);
        paymaster = new ParmeliaPaymaster(IEntryPoint(ENTRY_POINT));
        paymaster.setSponsorSigner(sponsor);
    }

    function _baseUserOp() internal pure returns (PackedUserOperation memory op) {
        op.sender = address(0xBEEF);
        op.nonce = 7;
        op.initCode = "";
        op.callData = hex"1234";
        op.accountGasLimits = bytes32(uint256(0x111));
        op.preVerificationGas = 100000;
        op.gasFees = bytes32(uint256(0x222));
        op.signature = "";
    }

    function _header() internal view returns (bytes memory) {
        return abi.encodePacked(address(paymaster), VER_GAS, POSTOP_GAS);
    }

    function _digest(PackedUserOperation memory op, uint48 validAfter, uint48 validUntil)
        internal
        view
        returns (bytes32)
    {
        bytes32 paymasterConfigHash = keccak256(_header());
        bytes memory encoded = abi.encode(
            block.chainid,
            address(paymaster),
            op.sender,
            op.nonce,
            keccak256(op.initCode),
            keccak256(op.callData),
            op.accountGasLimits,
            op.preVerificationGas,
            op.gasFees,
            paymasterConfigHash,
            uint256(validAfter),
            uint256(validUntil)
        );
        return keccak256(encoded);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sponsorPk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function _paymasterAndData(uint48 validAfter, uint48 validUntil, bytes memory sig)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(_header(), validAfter, validUntil, sig);
    }

    function test_validSponsorshipReturnsTimeBoundedValidationData() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, validAfter, validUntil));
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, sig);

        vm.prank(ENTRY_POINT);
        (bytes memory ctx, uint256 validationData) =
            paymaster.validatePaymasterUserOp(op, bytes32(0), 0);

        assertEq(ctx.length, 0);
        assertEq(validationData, ERC4337Utils.packValidationData(true, validAfter, validUntil));
    }

    function test_tamperedTimeBoundsReverts() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, validAfter, validUntil));
        // Sign for validUntil, but ship a different validUntil in the bytes.
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil + 1, sig);

        vm.prank(ENTRY_POINT);
        vm.expectRevert(ParmeliaPaymaster.InvalidPaymasterSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_wrongSignerReverts() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xB0B, MessageHashUtils.toEthSignedMessageHash(_digest(op, validAfter, validUntil)));
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, abi.encodePacked(r, s, v));

        vm.prank(ENTRY_POINT);
        vm.expectRevert(ParmeliaPaymaster.InvalidPaymasterSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_missingSignatureReverts() public {
        PackedUserOperation memory op = _baseUserOp();
        // Only the header + time bounds, no signature.
        op.paymasterAndData = abi.encodePacked(_header(), uint48(0), uint48(block.timestamp + 600));

        vm.prank(ENTRY_POINT);
        vm.expectRevert(ParmeliaPaymaster.MissingPaymasterSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_onlyEntryPointCanValidate() public {
        uint48 validUntil = uint48(block.timestamp + 600);
        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, 0, validUntil));
        op.paymasterAndData = _paymasterAndData(0, validUntil, sig);

        vm.expectRevert(ParmeliaPaymaster.OnlyEntryPoint.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }
}
