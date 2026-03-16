<?php

namespace App\Services;

use App\Models\Handler;
use App\Models\Dispatchable;

class UserHandler extends Handler implements Dispatchable
{
    public function dispatch(): void {}
}
