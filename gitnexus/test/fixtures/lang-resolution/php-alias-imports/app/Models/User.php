<?php
namespace App\Models;

class User {
    public string $name;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function save(): bool {
        return true;
    }
}
