struct Target {};
void caller(struct Target item) {}
void outer() { caller({}); }
const char *label = "Target";
