// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Base.sol";

contract Child is Base {
    function localPing() public pure returns (uint256) {
        return 2;
    }

    function viaThis() public pure returns (uint256) {
        return this.localPing();
    }

    function viaSuper() public pure returns (uint256) {
        return super.basePing();
    }

    function basePing() public pure override returns (uint256) {
        return 3;
    }
}
