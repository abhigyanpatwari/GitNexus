<?php
namespace App\Services;

use App\Models\User as U;
use App\Models\Repo as R;

class Main {
    public function run(): void {
        $u = new U("alice");
        $r = new R("https://example.com");
        $u->save();
        $r->persist();
    }
}
