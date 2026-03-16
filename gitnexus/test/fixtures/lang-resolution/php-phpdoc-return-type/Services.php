<?php
require_once 'Models.php';

class UserService {
    /**
     * @return User
     */
    public function getUser(string $name) {
        return new User();
    }

    /**
     * @return Repo
     */
    public function getRepo(string $path) {
        return new Repo();
    }

    public function processUser() {
        $user = $this->getUser("alice");
        $user->save();
    }

    public function processRepo() {
        $repo = $this->getRepo("/data");
        $repo->save();
    }

    /**
     * @param User $user the user to handle
     */
    public function handleUser($user) {
        $user->save();
    }

    /**
     * @param Repo $repo the repo to handle
     */
    public function handleRepo($repo) {
        $repo->save();
    }
}
