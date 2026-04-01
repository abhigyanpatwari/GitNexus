<?php
namespace App\Models;

class Dog extends Animal {
    public function speak(): string {
        return "woof";
    }
}
