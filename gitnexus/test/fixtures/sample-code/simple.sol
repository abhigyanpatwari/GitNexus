// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Base.sol";

interface IOwnable {
    function owner() external view returns (address);
}

library MathLib {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Ownable is IOwnable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setOwner(address newOwner) public onlyOwner {
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
        MathLib.add(1, 2);
    }

    function owner() public view returns (address) {
        return owner;
    }

    receive() external payable {}
}
