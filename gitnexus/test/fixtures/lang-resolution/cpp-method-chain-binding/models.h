#pragma once
#include <string>

class City {
public:
    std::string name;
    City(const std::string& n) : name(n) {}
    bool save() { return true; }
};

class Address {
public:
    City city;
    Address(const City& c) : city(c) {}
    City getCity() { return city; }
};

class User {
public:
    Address address;
    User(const Address& a) : address(a) {}
};

User getUser() {
    return User(Address(City("NYC")));
}
