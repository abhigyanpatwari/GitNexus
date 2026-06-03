// #1982 P3: a root-anchored base (`: ::A::Inner`) names the GLOBAL `::A::Inner`,
// NOT the enclosing-relative `Outer::Wrap::A::Inner`. Without the leading-`::`
// guard in resolveQualifiedInheritanceBase, the enclosing-prefix key
// `Wrap.A.Inner` is tried first and `D` mis-binds to the inner type. With the
// guard, only the root-anchored `A.Inner` key is tried → the global type.
struct A {
  struct Inner {
    void global_inner() {}
  };
};

namespace Outer {
struct Wrap {
  struct A {
    struct Inner {
      void wrap_inner() {}
    };
  };
  struct D : ::A::Inner {};
};
}  // namespace Outer
