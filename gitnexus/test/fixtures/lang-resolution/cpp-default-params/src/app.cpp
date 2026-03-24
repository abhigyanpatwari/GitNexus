#include <string>

std::string greet(std::string name, std::string greeting = "Hello") {
    return greeting + ", " + name;
}

void process() {
    greet("Alice");
    greet("Bob", "Hi");
}
