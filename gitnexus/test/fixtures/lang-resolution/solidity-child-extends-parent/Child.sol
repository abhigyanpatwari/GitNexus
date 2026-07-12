// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Parent.sol";

contract Child is Parent {
    function parentMethod() public pure override returns (string memory) {
        return "child";
    }
}
