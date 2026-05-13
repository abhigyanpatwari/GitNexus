<?php
namespace App\Traits;

trait TraitA {
    use TraitB;

    public function aMethod(): string {
        return 'from A';
    }
}
