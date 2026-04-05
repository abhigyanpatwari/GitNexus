#include "db_lookup.h"
#include "formatter.h"

class App {
public:
    void callById() {
        DbLookup db;
        db.find(42);
    }

    void callByName() {
        DbLookup db;
        db.find("alice");
    }

    void chainIntToFormat() {
        DbLookup db;
        Formatter fmt;
        std::string result = db.find(42);
        fmt.format(result);
    }

    void chainNameToFormat() {
        DbLookup db;
        Formatter fmt;
        std::string result = db.find("alice");
        fmt.format(result);
    }
};
