<?php

function greet(string $name, string $greeting = "Hello"): string {
    return "$greeting, $name";
}

function process(): void {
    greet("Alice");
    greet("Bob", "Hi");
}
