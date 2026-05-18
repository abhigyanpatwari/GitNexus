// SFINAE via C++20 `requires` clause (F4 AST shape from #1579).
// Same logical disambiguation as cpp-sfinae-golden — proves the
// constraint-extractor recognizes the requires-clause shape, not just
// `enable_if_t<>` defaults.
#include <type_traits>

template<class T> requires std::is_integral_v<T>
void process(T value) {
    (void)value;
}

template<class T> requires std::is_floating_point_v<T>
void process(T value) {
    (void)value;
}

void run() {
    process(42);
    process(3.14);
}
