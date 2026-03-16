<?php

namespace App\Contracts;

interface Repository
{
    public function find(int $id): mixed;
    public function save(mixed $entity): void;
}
