<?php
namespace App\Models;

abstract class Animal {
    abstract public function speak(): string;

    public static function classify(string $name): string {
        return "mammal";
    }

    final public function breathe(): bool {
        return true;
    }
}
