#include "processor.h"
#include "formatter.h"

class App {
public:
    // Cross-file: calls template-overloaded process() from another file
    void callProcessInt() {
        Processor p;
        std::vector<int> v;
        p.process(v);
    }

    void callProcessString() {
        Processor p;
        std::vector<std::string> v;
        p.process(v);
    }

    // Chain: process result feeds into format overload
    void chainIntToFormat() {
        Formatter fmt;
        fmt.format(42);
    }

    void chainStringToFormat() {
        Formatter fmt;
        fmt.format("hello");
    }
};
