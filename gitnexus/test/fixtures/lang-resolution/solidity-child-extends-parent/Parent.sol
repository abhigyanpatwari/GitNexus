// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IParent.sol";

contract Parent is IParent {
    function parentMethod() public pure virtual returns (string memory) {
        return "parent";
    }
}
