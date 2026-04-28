#pragma once
#include <string>

class ILookup {
public:
    virtual std::string find(int id) = 0;
    virtual std::string find(std::string name) = 0;
    virtual ~ILookup() = default;
};
