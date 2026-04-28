<?php
namespace App\Repositories;

use App\Contracts\Repository;

class SqlRepository implements Repository {
    public function find(int $id): array {
        return ['id' => $id];
    }

    public function save(array $entity): bool {
        return true;
    }
}
