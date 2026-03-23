<?php

namespace App\Services;

use App\Models\User;
use function App\Utils\formatName;
use const App\Config\MAX_RETRIES;

class Calculator {
    public function process(): void {
        $user = new User();
        $user->save();

        $name = formatName("test");
        echo MAX_RETRIES;
    }
}
