#include "lib.h"

namespace caller {
  void run() {
    // Unqualified `worker` — not in local compound_statement scope → treated
    // as a potential free-function reference. The workspace scan finds
    // worker() in BOTH alpha and beta namespaces, so BOTH are added to the
    // associated set. run_with() exists in both namespaces as well, so the
    // lookup yields two candidates (alpha::run_with, beta::run_with).
    // GitNexus ADL_AMBIGUOUS sentinel suppresses the edge — the caller emits
    // zero CALLS edges rather than picking one arbitrarily.
    run_with(worker);
  }
}
