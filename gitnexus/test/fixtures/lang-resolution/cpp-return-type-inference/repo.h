#pragma once

class Repo {
public:
    Repo(const char* name) : name_(name) {}
    bool save() { return true; }
private:
    const char* name_;
};
