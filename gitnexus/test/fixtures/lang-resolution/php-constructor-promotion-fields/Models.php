<?php

class Address {
    public string $city;

    public function save(): void {
        // persist address
    }
}

class User {
    public function __construct(
        public string $name,
        public Address $address,
    ) {}

    public function greet(): string {
        return $this->name;
    }
}
