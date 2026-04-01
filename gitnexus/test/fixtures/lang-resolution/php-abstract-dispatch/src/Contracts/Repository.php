<?php
namespace App\Contracts;

interface Repository {
    public function find(int $id): array;
    public function save(array $entity): bool;
}
