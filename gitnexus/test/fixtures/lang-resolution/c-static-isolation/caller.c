/* caller.c — includes only b.h, calls helper().
 * Should resolve to b.c:helper, NOT a.c:static helper. */
#include "b.h"

int main(void) {
    int x = helper();
    int y = public_b();
    return x + y;
}
