<?php

namespace App\Models;

class User
{
    public function save(): bool { return true; }
    public function process(): void
    {
        $this->save();
    }
}
