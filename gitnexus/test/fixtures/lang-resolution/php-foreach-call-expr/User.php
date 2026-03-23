<?php

class User {
    public string $name;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function save(): void {}
}

/**
 * @return User[]
 */
function getUsers(): array {
    return [new User("alice")];
}
