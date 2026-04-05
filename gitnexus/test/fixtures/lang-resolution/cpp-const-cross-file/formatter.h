#pragma once
#include <string>

class Formatter {
public:
    std::string format(std::string value) {
        return value;
    }

    std::string format(int value) {
        return std::to_string(value);
    }
};
