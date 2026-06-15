#include <initializer_list>
#include <vector>

namespace std {
template <typename T>
class initializer_list {};

template <typename T>
class vector {};
}

class InitListService {
public:
    void consume(std::initializer_list<int> values) {}
    void consume(int value) {}

    void consumeVector(std::vector<int> values) {}
    void consumeVector(int value) {}

    void consumeMixed(std::initializer_list<int> values) {}
    void consumeMixed(std::initializer_list<double> values) {}

    void consumeEmpty(std::initializer_list<int> values) {}
    void consumeEmpty(std::initializer_list<double> values) {}

    void callHomogeneousInitList() {
        consume({1, 2, 3});
    }

    void callHomogeneousVector() {
        consumeVector({1, 2, 3});
    }

    void callHeterogeneousInitList() {
        consumeMixed({1, 2.0});
    }

    void callEmptyInitList() {
        consumeEmpty({});
    }
};
