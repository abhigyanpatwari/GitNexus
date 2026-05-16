#pragma once

namespace audit {
  // A free function named `g` exists in the workspace. Without the local-fp
  // guard, a locally-declared `void (*g)()` variable would fall through to
  // EMPTY_ADL_ARG and not be treated as a free-function ref — but this test
  // specifically verifies that the local fp variable shadows the workspace
  // function of the same name and no namespace is contributed.
  void g();
  void record(void (*fn)());
}
