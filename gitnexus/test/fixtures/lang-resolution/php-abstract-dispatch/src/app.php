<?php
namespace App;

use App\Repositories\SqlRepository;

function process(): void {
    $repo = new SqlRepository();
    $user = $repo->find(42);
    $repo->save($user);
}
