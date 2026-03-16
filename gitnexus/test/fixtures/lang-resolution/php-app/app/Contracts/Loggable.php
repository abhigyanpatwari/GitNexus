<?php

namespace App\Contracts;

interface Loggable
{
    public function log(string $message): void;
}
