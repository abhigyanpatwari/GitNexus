#include "animal.hpp"

int main() {
    Dog dog;
    auto sound = dog.speak();
    auto category = Animal::classify("dog");
    return 0;
}
