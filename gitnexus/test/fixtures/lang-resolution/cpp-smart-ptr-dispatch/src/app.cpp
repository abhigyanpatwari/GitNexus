#include <memory>
#include <string>

class Animal {
public:
    virtual std::string speak() { return "..."; }
};

class Dog : public Animal {
public:
    std::string speak() override { return "woof"; }
};

void process() {
    auto dog = std::make_shared<Dog>();
    dog->speak();
}
