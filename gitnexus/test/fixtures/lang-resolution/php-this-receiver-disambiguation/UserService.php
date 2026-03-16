<?php
require_once 'Models.php';

class UserService {
    /** @return User */
    public function getUser(string $name) {
        return new User();
    }

    public function processUser() {
        $user = $this->getUser("alice");
        $user->save();
    }
}
