<?php

namespace App\Services;

use App\Models\User;
use App\Models\Repo;

class AppService
{
    public function processEntities(): void
    {
        $user = new User();
        $repo = new Repo();
        $user->save();
        $repo->save();
    }
}
