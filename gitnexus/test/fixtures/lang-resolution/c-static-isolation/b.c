/* b.c — contains a non-static (externally visible) helper function.
 * This function SHOULD be resolvable from caller.c. */
#include "b.h"

int helper(void) {
    return 99;
}

int public_b(void) {
    return helper();
}
