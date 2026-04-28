#include "container.h"
#include "formatter.h"

class App {
public:
    // Cross-file: calls non-const get(int) on mutable container
    void callMutableGet() {
        Container c;
        c.get(0);
    }

    // Cross-file: calls const get(int) on const container
    void callConstGet() {
        const Container c;
        c.get(0);
    }

    // Chain: mutable get(int) returns string -> format(string)
    void chainMutableGet() {
        Container c;
        Formatter fmt;
        std::string result = c.get(0);
        fmt.format(result);
    }

    // Chain: const size() returns int -> format(int)
    void chainConstSize() {
        const Container c;
        Formatter fmt;
        int n = c.size();
        fmt.format(n);
    }
};
