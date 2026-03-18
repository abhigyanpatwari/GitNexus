#pragma once

class City {
public:
    std::string zipCode;

    std::string getName() {
        return "city";
    }
};

class Address {
public:
    City city;
    std::string street;

    void save() {
        // persist address
    }
};

class User {
public:
    std::string name;
    Address address;

    std::string greet() {
        return name;
    }
};
