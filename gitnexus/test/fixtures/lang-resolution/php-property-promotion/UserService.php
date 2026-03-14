<?php

class UserRepo {
    public function find(int $id): void {}
    public function save(): void {}
}

class UserService {
    public function __construct(
        private UserRepo $repo
    ) {
        // Promoted parameter $repo is available as a local variable in the constructor
        $repo->save();
    }
}
