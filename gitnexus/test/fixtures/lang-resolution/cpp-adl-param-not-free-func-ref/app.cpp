#include "utils.h"

namespace caller {
  // `callback` is a plain int parameter, not a function reference.
  // Without the fix: `callback` is not found in the compound_statement
  // (parameters live in parameter_list) → lookupAdlIdentifierType returns null
  // → treated as free-function ref → workspace scan finds utils::callback
  // → `utils` added to ADL set → run_with resolves to utils::run_with (false positive).
  // With the fix: isIdentifierAFunctionParameter detects `callback` in the
  // parameter_list → returns EMPTY_ADL_ARG → no namespace contributed → 0 CALLS edges.
  void run(int callback) {
    run_with(callback);
  }
}
