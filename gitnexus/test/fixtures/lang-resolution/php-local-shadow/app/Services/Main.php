<?php
namespace App\Services;

use function App\Utils\save;

// Local function shadows imported save
function save(string $data): void {
    echo "local save: $data\n";
}

function run(): void {
    save("test");
}
