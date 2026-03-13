// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {SignerWebAuthn} from "@openzeppelin/contracts/utils/cryptography/signers/SignerWebAuthn.sol";
import {SignerP256} from "@openzeppelin/contracts/utils/cryptography/signers/SignerP256.sol";


contract AccountWebAuthn is
    Initializable,
    Account,
    EIP712,
    ERC7739,
    ERC7821,
    SignerWebAuthn,
    ERC721Holder,
    ERC1155Holder
{
    constructor()
        EIP712("AccountWebAuthn", "1")
        SignerP256(
            0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
            0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
        )
    {}

    /*
     * FUTURE V2 RECOVERY PLAN (preferably in a new deployment / network migration):
     * 1. Replace the initializer-only signer model with explicit signer management in storage.
     * 2. Add rotateWebAuthnSigner(bytes32 newQx, bytes32 newQy) restricted to self-call
     *    through a valid UserOperation signed by the current signer.
     * 3. Support more than one signer so the user can keep a primary passkey plus a backup
     *    passkey from another ecosystem or device family.
     * 4. Add a recovery path with guardians or a timelocked recovery signer so losing one
     *    device does not permanently strand funds.
     * 5. Emit signer change events and expose signer version metadata so the backend can keep
     *    credential hints in sync without treating credentialId as a hard dependency.
     *
     * Current limitation: initializeWebAuthn uses `initializer`, so this implementation can
     * only set the signer once and cannot rotate the passkey on the same wallet address.
     */
    function initializeWebAuthn(bytes32 qx, bytes32 qy) public initializer {
        _setSigner(qx, qy);  // Set the P256 public key
    }

    /**
     * @dev Override to allow EntryPoint to execute transactions
     */
     function _erc7821AuthorizedExecutor(
         address caller,
         bytes32 mode,
         bytes calldata executionData
     ) internal view override returns (bool) {
         return
             caller == address(entryPoint()) ||
             super._erc7821AuthorizedExecutor(caller, mode, executionData);
     }
}

