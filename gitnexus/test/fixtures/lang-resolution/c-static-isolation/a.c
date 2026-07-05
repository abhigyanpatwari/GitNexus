/* a.c — contains a static (file-local) helper function.
 * This function must NOT be resolvable from caller.c. */
static int helper(void) {
    return 42;
}

int public_a(void) {
    return helper();
}
