#include "data.h"

namespace caller {
  // data::value is a namespace-qualified VARIABLE, not a function.
  // ADL must NOT contribute `data` to the associated namespace set — the
  // argument type is `int`, which has no associated namespaces in ISO C++.
  // GitNexus guards: collectFunctionRefNamespaces verifies a Function/Method
  // named `value` exists in `data` before contributing. Since `data::value`
  // is a variable (not a function), `data` is NOT added, and process() is
  // not resolved via ADL.
  void run() {
    process(data::value);
  }
}
