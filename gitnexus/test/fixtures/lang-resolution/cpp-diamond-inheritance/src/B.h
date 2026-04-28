#pragma once
#include "Base.h"

// See the comment in A.h — both sides of the diamond use virtual inheritance
// so there is exactly one `Base` subobject under `Derived`.
class B : virtual public Base {
};
