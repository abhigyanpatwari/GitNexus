#pragma once
#include "Base.h"

// Virtual inheritance: together with `B : virtual public Base`, this creates
// a single shared `Base` subobject under `Derived`, so `d.method()` is an
// unambiguous call in real C++. Without the `virtual` keyword, a non-virtual
// diamond would produce two separate `Base` subobjects and the call would
// be ambiguous, requiring `d.A::method()` or `d.B::method()` to disambiguate.
class A : virtual public Base {
};
