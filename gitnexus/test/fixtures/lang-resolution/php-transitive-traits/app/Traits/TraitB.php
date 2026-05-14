<?php
namespace App\Traits;

trait TraitB {
    use TraitC;

    public function bMethod(): string {
        return 'from B';
    }
}
