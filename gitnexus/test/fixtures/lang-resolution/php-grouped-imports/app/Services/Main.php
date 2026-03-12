<?php
namespace App\Services;

use App\Models\{User, Repo as R};

class Main {
    public function run(): void {
        $u = new User();
        $u->save();

        $r = new R();
        $r->persist();
    }
}
