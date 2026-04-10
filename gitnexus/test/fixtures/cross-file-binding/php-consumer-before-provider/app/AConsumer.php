<?php

namespace App;

use function App\Models\getUser;

class AConsumer {
    public function run(): void {
        $u = getUser();
        $u->save();
    }
}
