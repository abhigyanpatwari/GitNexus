// Filter ordering: arity gate runs BEFORE constraint filter, so a
// bad-arity candidate is dropped even when its constraint would have
// returned 'unknown' (and thus kept it). Asserts exactly 1 CALLS edge
// to the good overload — guards the filter-step ordering invariant.
#include <type_traits>

template<class T>
constexpr bool MyCustomTrait_v = true;

template<class T, std::enable_if_t<MyCustomTrait_v<T>, int> = 0>
void process(T value) {
    (void)value;
}

template<class T, std::enable_if_t<MyCustomTrait_v<T>, int> = 0>
void process(T value, T other) {
    (void)value;
    (void)other;
}

void run() {
    process(42);
}
