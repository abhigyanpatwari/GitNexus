<?php
namespace App\Models;

class Repo {
    public string $url;

    public function __construct(string $url) {
        $this->url = $url;
    }

    public function persist(): bool {
        return true;
    }
}
