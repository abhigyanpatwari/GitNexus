// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EventsAndErrors {
    event Transfer(address indexed to, uint256 amount);
    error Unauthorized(address who);

    function pay(address to, uint256 amount) public {
        emit Transfer(to, amount);
    }

    function deny(address who) public pure {
        revert Unauthorized(who);
    }
}
