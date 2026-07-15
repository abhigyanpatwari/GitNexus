// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Base {
    function basePing() public pure virtual returns (uint256) {
        return 1;
    }
}
