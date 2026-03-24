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

    void run() {
        lookup(42);        // literal int → should disambiguate to lookup(int)
        lookup("alice");   // literal string → should disambiguate to lookup(string)
    }
};
