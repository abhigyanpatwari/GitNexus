#pragma once
#include <string>

class Repo {
public:
    Repo(const std::string& name) : name_(name) {}
    bool save() { return false; }
private:
    std::string name_;
};
