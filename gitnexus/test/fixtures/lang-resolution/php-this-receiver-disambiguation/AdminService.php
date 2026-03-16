<?php
require_once 'Models.php';

class AdminService {
    /** @return Repo */
    public function getUser(string $name) {
        return new Repo();
    }

    public function processAdmin() {
        $repo = $this->getUser("admin");
        $repo->save();
    }
}
