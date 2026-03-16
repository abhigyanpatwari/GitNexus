<?php
namespace App\Services;

use App\Models\User;
use App\Models\Repo;

class AppService {
    public function process(User $user, Repo $repo): void {
        $alias = $user;
        $alias->save();

        $rAlias = $repo;
        $rAlias->save();
    }
}
