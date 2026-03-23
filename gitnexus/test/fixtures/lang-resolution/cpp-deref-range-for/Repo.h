#pragma once
#include <string>

class Repo {
public:
    Repo(const std::string& name) : name_(name) {}
    void save() {}
private:
    std::string name_;
};
