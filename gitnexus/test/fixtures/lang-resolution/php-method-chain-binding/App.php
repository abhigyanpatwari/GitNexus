<?php

class City {
    public string $name;
    public function __construct(string $name) { $this->name = $name; }
    public function save(): bool { return true; }
}

class Address {
    public City $city;
    public function __construct(City $city) { $this->city = $city; }
    public function getCity(): City { return $this->city; }
}

class User {
    public Address $address;
    public function __construct(Address $address) { $this->address = $address; }
}

function getUser(): User {
    return new User(new Address(new City("NYC")));
}

function processChain(): void {
    $user = getUser();
    $city = $user->getCity();
    $city->save();
}
