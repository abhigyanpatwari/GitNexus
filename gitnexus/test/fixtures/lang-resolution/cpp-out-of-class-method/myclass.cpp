#include "myclass.h"
#include <iostream>

void MyClass::greet() {
    std::cout << "Hello World!";
}

std::string MyClass::getName() {
    return "default";
}

void MyClass::greet(std::string msg) {
    std::cout << msg;
}

std::string MyClass::getName(int id) {
    return "name-" + std::to_string(id);
}
