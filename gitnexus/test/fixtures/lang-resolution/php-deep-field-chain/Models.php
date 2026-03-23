<?php

class City {
    /** @var string */
    public string $zipCode;

    public function getName(): string {
        return "city";
    }
}

class Address {
    /** @var City */
    public City $city;

    /** @var string */
    public string $street;

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
