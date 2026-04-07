#pragma once
#include <string>

class MyClass {
public:
    void greet();
    std::string getName();

    void greet(std::string msg);
    std::string getName(int id);
};
