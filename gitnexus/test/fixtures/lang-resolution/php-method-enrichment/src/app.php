<?php
namespace App;

use App\Models\Dog;

function main(): void {
    $dog = new Dog();
    $sound = $dog->speak();
    $category = Dog::classify("dog");
}
