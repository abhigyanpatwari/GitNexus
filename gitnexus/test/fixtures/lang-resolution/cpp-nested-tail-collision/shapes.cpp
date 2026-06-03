struct Outer {
  struct Inner {
    void from_outer() {}
    int outer_field;
  };
};
struct Other {
  struct Inner {
    void from_other() {}
  };
};
// #1982 same-tail heritage: each base is fully qualified, so the EXTENDS edge
// must resolve to the matching nested node, not the first-inserted same-tail one.
struct DerivedA : Outer::Inner {};
struct DerivedB : Other::Inner {};
