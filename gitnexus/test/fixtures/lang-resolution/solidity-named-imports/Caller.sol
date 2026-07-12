// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {MathLib, Helper as H} from "./Lib.sol";

contract Caller {
    function run(H h) public pure returns (uint256) {
        return MathLib.add(h.ping(), 2);
    }
}
