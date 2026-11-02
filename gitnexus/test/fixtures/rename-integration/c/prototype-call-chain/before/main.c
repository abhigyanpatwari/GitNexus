#include "api.h"
int middle(int value) { return compute(value, 1.0f); }
int outer(int value) { return middle(value); }
int shadow(int compute) { return compute; }
const char *label = "compute";
// compute must remain in this comment.
