struct restrict {};
void caller(struct restrict item) {}
void outer() { caller({}); }
const char *label = "Target";
