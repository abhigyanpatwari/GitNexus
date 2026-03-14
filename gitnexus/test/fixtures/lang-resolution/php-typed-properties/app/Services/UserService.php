<?php

namespace App\Services;

use App\Models\UserRepo;

class UserService
{
    private UserRepo $repo;

    public function process(UserRepo $repo): void
    {
        $repo->save();
    }
}
