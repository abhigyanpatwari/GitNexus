<?php

namespace App\Services;

use App\Contracts\Repository;
use App\Models\User;
use App\Enums\UserRole;

class UserService implements Repository
{
    private array $users = [];

    public function find(int $id): ?User
    {
        return $this->users[$id] ?? null;
    }

    public function save(mixed $entity): void
    {
        $this->users[$entity->getId()] = $entity;
    }

    public function createUser(string $name, string $email): User
    {
        $user = new User($name, $email);
        $this->save($user);
        $user->log('User created: ' . $name);
        $user?->touch();
        $defaultRole = UserRole::Viewer;
        $label = $defaultRole->label();
        return $user;
    }

    public static function instance(): self
    {
        return new self();
    }
}
