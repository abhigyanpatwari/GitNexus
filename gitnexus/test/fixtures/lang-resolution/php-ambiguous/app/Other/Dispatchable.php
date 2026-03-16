<?php

namespace App\Other;

interface Dispatchable
{
    public function queue(): void;
}
