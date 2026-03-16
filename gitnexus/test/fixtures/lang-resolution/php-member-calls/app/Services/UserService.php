<?php

namespace App\Services;

use App\Models\User;

class UserService
{
    public function processUser(): bool
    {
        $user = new User();
        return $user->save();
    }
}
