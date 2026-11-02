struct Leaf { int amount; };
struct Branch { struct Leaf *leaf; };
struct Root { struct Branch *branch; };
struct Other { int value; };
int read(struct Root *root, struct Other *other) {
    return root->branch->leaf->amount + other->value;
}
void write(struct Root *root, int value) {
    root->branch->leaf->amount = value;
}
const char *label = "value";
// value belongs to Leaf, Other and a parameter, independently.
