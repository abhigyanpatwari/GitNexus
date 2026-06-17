#include <initializer_list>
#include <string>
#include <vector>

namespace std {
template <typename T>
class initializer_list {};

template <typename T>
class vector {};

class string {};
}

class InitListService {
public:
    void consume(std::initializer_list<int> values) {}
    void consume(int value) {}

    void consumeVector(std::vector<int> values) {}
    void consumeVector(int value) {}

    void consumeScalarOrVector(std::vector<int> values) {}
    void consumeScalarOrVector(int value) {}

    void consumeStringVectorMismatch(std::vector<int> values) {}
    void consumeStringVectorMismatch(std::string value) {}

    void consumeMixed(std::initializer_list<int> values) {}
    void consumeMixed(std::initializer_list<double> values) {}

    void consumeEmpty(std::initializer_list<int> values) {}
    void consumeEmpty(std::initializer_list<double> values) {}

    void consumeSingleMixed(std::initializer_list<int> values) {}
    void consumeSingleEmpty(std::initializer_list<int> values) {}

    void callHomogeneousInitList() {
        consume({1, 2, 3});
    }

    void callHomogeneousVector() {
        consumeVector({1, 2, 3});
    }

    void callSingleElementScalar() {
        consumeScalarOrVector({5});
    }

    void callStringVectorMismatch() {
        consumeStringVectorMismatch({"a", "b"});
    }

    void callHeterogeneousInitList() {
        consumeMixed({1, 2.0});
    }

    void callEmptyInitList() {
        consumeEmpty({});
    }

    void callSingleHeterogeneousInitList() {
        consumeSingleMixed({1, 2.0});
    }

    void callSingleEmptyInitList() {
        consumeSingleEmpty({});
    }
};
