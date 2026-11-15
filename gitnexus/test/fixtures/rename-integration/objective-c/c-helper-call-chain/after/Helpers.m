static int compute(int value) { return value; }
int leaf(void) { return compute(1); }
int middle(void) { return leaf(); }
int entry(void) { return middle(); }
int shadow(int calculate) { return calculate; }
const char *label = "calculate";
// calculate remains a comment.
