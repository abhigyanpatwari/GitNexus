<?php

namespace App\Models;

class User extends BaseModel implements Serializable
{
    public function serialize(): string { return ''; }
}
