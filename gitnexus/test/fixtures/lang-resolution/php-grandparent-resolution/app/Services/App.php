<?php

namespace App\Services;

use App\Models\C;

class App
{
    public function process(): void
    {
        $c = new C();
        $c->greet()->save();
    }
}
