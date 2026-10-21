#include "mod.h"

// `make` is reached through the using-directive; its return type is the
// namespace prototype's `C`, which must mean rp::C even though a global C
// exists elsewhere in the workspace.
int using_auto() { using namespace rp; auto x = make(); return x.m(); }

// The prototype's `Widget` is rp::Widget, not the global Widget declared in the
// same header.
int using_same_file() { using namespace rp; auto x = makeWidget(); return x.m(); }
