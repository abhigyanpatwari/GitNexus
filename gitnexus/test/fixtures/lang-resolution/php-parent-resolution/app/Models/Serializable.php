<?php

namespace App\Models;

interface Serializable
{
    public function serialize(): string;
}
