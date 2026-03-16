<?php

namespace Models;

class User {
    private string $name;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function save(): bool {
        return true;
    }
}
