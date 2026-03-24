<?php

namespace App;

use function App\Models\getUser;

class Main {
    public function run(): void {
        $u = getUser();
        $u->save();
        $u->getName();
    }
}
