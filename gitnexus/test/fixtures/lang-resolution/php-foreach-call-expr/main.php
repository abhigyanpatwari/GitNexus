<?php

require_once 'User.php';
require_once 'Repo.php';

function processUsers(): void {
    foreach (getUsers() as $user) {
        $user->save();
    }
}

function processRepos(): void {
    foreach (getRepos() as $repo) {
        $repo->save();
    }
}
