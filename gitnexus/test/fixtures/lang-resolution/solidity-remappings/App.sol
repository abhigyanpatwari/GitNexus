// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Helper.sol";

contract App {
    function run() public pure returns (uint256) {
        return Helper.ping();
    }
}
