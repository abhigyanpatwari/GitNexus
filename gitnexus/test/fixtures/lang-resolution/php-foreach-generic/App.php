<?php

require_once 'User.php';
require_once 'Repo.php';

class App {
    /**
     * PHPDoc generic Collection<User> — element type should resolve to User, not Collection.
     * @param Collection<User> $users
     */
    public function processCollection($users): void {
        foreach ($users as $user) {
            $user->save();
        }
    }

    /**
     * PHPDoc array-style User[] — existing behavior, should still work.
     * @param User[] $repos
     */
    public function processArray(array $repos): void {
        foreach ($repos as $repo) {
            $repo->save();
        }
    }
}
