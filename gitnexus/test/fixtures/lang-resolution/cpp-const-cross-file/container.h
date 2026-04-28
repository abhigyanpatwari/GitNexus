#pragma once
#include <string>

class Container {
public:
    std::string get(int index) {
        return "mutable";
    }

    std::string get(int index) const {
        return "const";
    }

    int size() {
        return count_;
    }

    int size() const {
        return count_;
    }

private:
    int count_ = 0;
};
