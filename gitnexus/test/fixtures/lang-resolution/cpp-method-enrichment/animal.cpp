#include "animal.hpp"

std::string Animal::classify(const std::string& name) {
    return "mammal";
}

bool Animal::breathe() {
    return true;
}

std::string Dog::speak() {
    return "woof";
}
