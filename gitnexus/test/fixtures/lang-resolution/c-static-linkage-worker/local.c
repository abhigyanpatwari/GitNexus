/* local.c — a file-local `static` function `compute`.
 *
 * `static` gives C translation-unit (file-local) linkage: `compute` is NOT
 * visible to any other translation unit. Its simple name collides with a
 * free function of the same name defined in `lib.c`, so the cross-file
 * resolver must NOT mistake one for the other. */
static int compute(int x) {
    return x + 1;
}

int local_entry(void) {
    return compute(41);
}
