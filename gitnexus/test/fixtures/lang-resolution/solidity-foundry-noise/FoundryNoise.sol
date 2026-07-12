// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Minimal Foundry-style noise — `vm` should not produce CALLS edges.
contract FoundryNoise {
    function setUp() public {
        // Unresolved vm — must not create a CALLS edge to a random symbol.
        vm.prank(address(1));
        require(true);
    }
}
