#pragma once
#include <string>

class Repo {
public:
    Repo(const std::string& dbName) : dbName_(dbName) {}
    bool save() { return false; }
private:
    std::string dbName_;
};
