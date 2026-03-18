#pragma once

class Address {
public:
    std::string city;

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
