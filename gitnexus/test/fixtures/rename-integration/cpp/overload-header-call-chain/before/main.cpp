#include "api.h"
bool compute(bool flag) { return flag; }
int middle() { return compute(1); }
int outer() { return middle(); }
double floating() { return compute(1.5); }
bool boolean() { return compute(true); }
const char *label = "compute";
// Only the integer compute overload is renamed.
