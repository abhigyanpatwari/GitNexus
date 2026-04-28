#pragma once
#include <vector>
#include <string>

class Processor {
public:
    void process(std::vector<int> items) {
        // process ints
    }

    void process(std::vector<std::string> items) {
        // process strings
    }

    void callVectorInt() {
        std::vector<int> v;
        process(v);
    }

    void callVectorString() {
        std::vector<std::string> v;
        process(v);
    }
};
