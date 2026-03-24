<?php

class User {
    public string $name;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function save(): bool {
        return true;
    }
}

function getUser(string $name): User {
    return new User($name);
}

function processUser(): void {
    $user = getUser("alice");
    $user->save();
}
