<?php

namespace App\Models;

class User {
    public function save(): void {}
}

function getUser(): User {
    return new User();
}
