#pragma once
#include <string>

class User {
public:
    User(const std::string& n) : name_(n) {}
    bool save() { return true; }
private:
    std::string name_;
};

User getUser(const std::string& name) {
    return User(name);
}
