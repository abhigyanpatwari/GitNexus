struct Base { virtual int calculate() { return 1; } };
struct Child : Base { int calculate() override { return 2; } };
struct Grandchild : Child { int calculate() override { return 3; } };
struct Other { int compute() { return 4; } };
int dispatch(Base& base, Child& child, Grandchild& grandchild, Other& other) {
    return base.calculate() + child.calculate() + grandchild.calculate() + other.compute();
}
const char *label = "compute";
// compute on Other is unrelated to the virtual family.
