<?php

namespace App\Services;

use App\Models\User;

class UserService {
    public function getUser(string $name): User {
        return new User($name);
    }

    public function processUser(): void {
        $user = $this->getUser("alice");
        $user->save();
    }
}
