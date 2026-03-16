<?php

use Models\User;

function processUser(string $name): void {
    $user = new User($name);
    $user->save();
}
