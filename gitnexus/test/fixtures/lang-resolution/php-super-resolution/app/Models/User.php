<?php

namespace App\Models;

class User extends BaseModel
{
    public function save(): bool
    {
        parent::save();
        return true;
    }
}
