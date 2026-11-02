int compute(int value) { return value + 1; }
int caller() { return compute(2); }
const char *label = "compute";
// compute is renamed only at semantic references.
