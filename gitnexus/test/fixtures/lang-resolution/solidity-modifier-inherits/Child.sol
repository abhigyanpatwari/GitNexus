// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Base.sol";

contract Child is Base {
    function setOwner(address next) public onlyOwner {
        owner = next;
    }
}
