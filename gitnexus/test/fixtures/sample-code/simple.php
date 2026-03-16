<?php

function topLevelFunction(string $name): string {
    return "Hello, " . $name;
}

class UserRepository {
    private array $users = [];

    public function addUser(string $name): void {
        $this->users[] = $name;
    }

    private function validateName(string $name): bool {
        return strlen($name) > 0;
    }

    public function getUsers(): array {
        return $this->users;
    }
}
