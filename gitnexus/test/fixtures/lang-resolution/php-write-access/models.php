<?php

class Address {
    public string $city;
}

class User {
    public string $name;
    public Address $address;
    public static int $count = 0;
}
