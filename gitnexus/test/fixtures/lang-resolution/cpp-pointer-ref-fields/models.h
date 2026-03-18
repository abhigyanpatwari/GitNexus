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
    Address* address;       // raw pointer member field
    Address& ref_address;   // reference member field
    std::string name;

    std::string greet() {
        return name;
    }
};
