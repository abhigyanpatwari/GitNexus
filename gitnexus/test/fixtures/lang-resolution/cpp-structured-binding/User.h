#pragma once
#include <string>

class User {
public:
    User(const std::string& name) : name_(name) {}
    void save() {}
private:
    std::string name_;
};
