// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Guarded {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    modifier onlyRole(bytes32 role) {
        require(role != bytes32(0));
        _;
    }

    function setOwner(address next) public onlyOwner {
        owner = next;
    }

    function privileged(bytes32 role) public onlyOwner onlyRole(role) {
        owner = address(uint160(uint256(role)));
    }
}
