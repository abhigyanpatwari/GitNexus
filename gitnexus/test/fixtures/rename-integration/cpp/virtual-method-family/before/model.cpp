struct Base { virtual int compute() { return 1; } };
struct Child : Base { int compute() override { return 2; } };
struct Grandchild : Child { int compute() override { return 3; } };
struct Other { int compute() { return 4; } };
int dispatch(Base& base, Child& child, Grandchild& grandchild, Other& other) {
    return base.compute() + child.compute() + grandchild.compute() + other.compute();
}
const char *label = "compute";
// compute on Other is unrelated to the virtual family.
