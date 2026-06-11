/* caller.c — calls `compute()`.
 *
 * It does NOT `#include "local.c"` (and could not — `local.c`'s `compute` is
 * `static`, so it has file-local linkage and is invisible cross-file). The
 * only legitimate cross-file `compute` target is `lib.c`'s free function,
 * reached via the global free-call fallback (C `#include` brings in all
 * non-static symbols).
 *
 * The regression guarded here: on the worker-only parse path (#1983), the
 * `static`-linkage map populated in the worker is lost across the boundary,
 * so without the capture side-channel `local.c`'s `static compute` looks
 * non-file-local on the main thread and the global fallback emits a FALSE
 * `caller_entry -> compute@local.c` CALLS edge. */
int caller_entry(void) {
    return compute(7);
}
