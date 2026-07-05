// Monotonicity contract: unknown predicates keep both candidates.
// `MyCustomTrait_v` is NOT in the Tier-A registry, so both overloads'
// constraint check returns 'unknown' → both survive narrowing → fall
// through to `isOverloadAmbiguousAfterNormalization` (both have
// parameterTypes=['T']) → edge suppressed.
//
// Asserts CALLS.length === 0 — adding a predicate must never produce a
// wrong edge; the worst case is the pre-existing "degrade not lie"
// suppression.
#include <type_traits>

template<class T>
constexpr bool MyCustomTrait_v = true;

template<class T, std::enable_if_t<MyCustomTrait_v<T>, int> = 0>
void process(T value) {
    (void)value;
}

template<class T, std::enable_if_t<!MyCustomTrait_v<T>, int> = 0>
void process(T value) {
    (void)value;
}

void run() {
    process(42);
}
