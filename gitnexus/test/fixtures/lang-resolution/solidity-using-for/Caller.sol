// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./MathLib.sol";

contract Caller {
    using MathLib for uint256;

    function run(uint256 x) public pure returns (uint256) {
        return x.add(2);
    }
}
