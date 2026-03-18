<?php

class Repo {
    public string $name;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function save(): void {}
}

/**
 * @return Repo[]
 */
function getRepos(): array {
    return [new Repo("main")];
}
