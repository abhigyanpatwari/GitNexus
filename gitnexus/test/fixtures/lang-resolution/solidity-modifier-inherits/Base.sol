// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Base {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }
}
