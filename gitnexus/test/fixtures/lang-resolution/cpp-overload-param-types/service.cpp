#include <string>

class User {};

class UserService {
public:
    User* lookup(int id) {
        return nullptr;
    }

    User* lookup(std::string name) {
        return nullptr;
    }

    void callById() {
        lookup(42);        // literal int → must resolve to lookup(int) only
    }

    void callByName() {
        lookup("alice");   // literal string → must resolve to lookup(string) only
    }
};
