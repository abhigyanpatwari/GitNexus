// SFINAE golden case (issue #1579).
// Two `process<T>` overloads guarded by mutually-exclusive enable_if_t
// predicates. ISO C++: process(42) → integral overload (line 7);
// process(3.14) → floating overload (line 12). V1 pre-fix: ambiguous,
// 0 CALLS edges. With constraintCompatibility wired up: 2 edges.
#include <type_traits>

template<class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void process(T value) {
    (void)value;
}

template<class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
void process(T value) {
    (void)value;
}

void run() {
    process(42);
    process(3.14);
}
