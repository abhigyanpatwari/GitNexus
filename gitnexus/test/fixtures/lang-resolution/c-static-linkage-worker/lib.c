/* lib.c — a non-static (externally visible) free function `compute`.
 * Declared in lib.h so callers can `#include` it and resolve to THIS one. */
#include "lib.h"

int compute(int x) {
    return x * 2;
}
