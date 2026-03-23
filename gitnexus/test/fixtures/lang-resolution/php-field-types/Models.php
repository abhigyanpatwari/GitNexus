<?php

class Address {
    /** @var string */
    public string $city;

    public function save(): void {
        // persist address
    }
}

class User {
    /** @var string */
    public string $name;

    /** @var Address */
    public Address $address;

    public function greet(): string {
        return $this->name;
    }
}
