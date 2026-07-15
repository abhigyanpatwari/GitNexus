// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Child.sol";

contract App {
    function run(Child c) public pure returns (string memory) {
        return c.parentMethod();
    }
}
