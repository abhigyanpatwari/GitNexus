<?php

namespace App\Services;

use App\Models\User;
use App\Models\Repo;

class AppService
{
    public function processEntities(User $user, Repo $repo): void
    {
        $user->save();
        $repo->save();
    }
}
