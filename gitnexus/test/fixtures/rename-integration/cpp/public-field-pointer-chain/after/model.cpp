struct Leaf { int amount; };
struct Branch { Leaf* leaf; };
struct Root { Branch* branch; };
struct Other { int value; };
int read(Root& root, Other& other) {
    return root.branch->leaf->amount + other.value;
}
void write(Root& root, int value) {
    root.branch->leaf->amount = value;
}
const char *label = "value";
// value on Other must remain unchanged.
