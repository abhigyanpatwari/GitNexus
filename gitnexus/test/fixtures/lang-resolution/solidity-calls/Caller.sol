// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./MathLib.sol";

contract Caller {
    function run() public pure returns (uint256) {
        return MathLib.add(1, 2);
    }
}
