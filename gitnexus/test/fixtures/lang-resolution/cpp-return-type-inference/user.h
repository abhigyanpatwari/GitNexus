#pragma once

class User {
public:
    User(const char* name) : name_(name) {}
    bool save() { return true; }
private:
    const char* name_;
};
