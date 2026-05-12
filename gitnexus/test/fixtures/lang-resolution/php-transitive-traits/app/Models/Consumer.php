<?php
namespace App\Models;

use App\Traits\TraitA;

class Consumer {
    use TraitA;

    public function callDepthOne(): string {
        return $this->aMethod();
    }

    public function callDepthTwo(): string {
        return $this->bMethod();
    }

    public function callDepthThree(): string {
        return $this->deepMethod();
    }
}
