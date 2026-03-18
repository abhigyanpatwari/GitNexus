<?php

require_once 'models.php';

function updateUser(User $user) {
    // Simple write
    $user->name = "Alice";

    // Object write
    $user->address = new Address();

    // Static property write
    User::$count = 42;

    // Compound assignment write
    $user->name .= " Smith";
}
