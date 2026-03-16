#pragma once
#include <string>

class User {
public:
    User(const std::string& name) : name_(name) {}
    bool save() { return true; }
private:
    std::string name_;
};
