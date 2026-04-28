#pragma once
#include "ilookup.h"

class DbLookup : public ILookup {
public:
    std::string find(int id) override {
        return "by-id";
    }

    std::string find(std::string name) override {
        return "by-name";
    }
};
