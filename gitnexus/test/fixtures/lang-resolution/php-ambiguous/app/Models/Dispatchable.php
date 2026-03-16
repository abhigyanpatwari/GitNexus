<?php

namespace App\Models;

interface Dispatchable
{
    public function dispatch(): void;
}
