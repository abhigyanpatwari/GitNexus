#include "audit.h"

namespace app {
  void run() {
    // `g` is a locally-declared function-pointer variable. audit::g() also
    // exists in the workspace. The local-fp guard (foundAsLocalFunctionPointer)
    // must detect `g` as a function-pointer variable declaration and return
    // EMPTY_ADL_ARG, preventing the workspace scan that would otherwise find
    // audit::g and contribute `audit` to the ADL associated set.
    void (*g)();
    record(g);
  }
}
