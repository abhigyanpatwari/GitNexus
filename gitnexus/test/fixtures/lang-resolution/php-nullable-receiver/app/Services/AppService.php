<?php

namespace App\Services;

use App\Models\User;
use App\Models\Repo;

class AppService
{
    public function process(?User $user, ?Repo $repo): void
    {
        // Nullable type-hinted params — should disambiguate via unwrapped type
        $user->save();
        $repo->save();
    }
}
