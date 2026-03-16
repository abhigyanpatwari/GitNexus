<?php

namespace App\Models;

use App\Contracts\Loggable;
use App\Traits\HasTimestamps;

abstract class BaseModel implements Loggable
{
    use HasTimestamps;

    protected int $id;

    public function getId(): int
    {
        return $this->id;
    }

    public function log(string $message): void
    {
        error_log($message);
    }
}
