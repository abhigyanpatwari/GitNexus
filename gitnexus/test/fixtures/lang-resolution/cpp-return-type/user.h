#pragma once

class User {
public:
    User(const char* name) : name_(name) {}
    void save() {}
private:
    const char* name_;
};

User getUser(const char* name);
