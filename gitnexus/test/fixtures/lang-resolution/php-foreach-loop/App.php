<?php

require_once 'User.php';

class App {
    /** @param User[] $users */
    public function processUsers(array $users): void {
        foreach ($users as $user) {
            $user->save();
        }
    }
}
