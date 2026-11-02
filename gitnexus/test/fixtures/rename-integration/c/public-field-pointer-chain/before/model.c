struct Leaf { int value; };
struct Branch { struct Leaf *leaf; };
struct Root { struct Branch *branch; };
struct Other { int value; };
int read(struct Root *root, struct Other *other) {
    return root->branch->leaf->value + other->value;
}
void write(struct Root *root, int value) {
    root->branch->leaf->value = value;
}
const char *label = "value";
// value belongs to Leaf, Other and a parameter, independently.
