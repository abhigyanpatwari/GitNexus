// Same-tail nested heritage INSIDE a namespace (#1982 follow-up).
//
// `NS::A::Inner` and `NS::B::Inner` are distinct nested types. The structure
// phase materializes distinct `NS.A.Inner` / `NS.B.Inner` graph nodes, but the
// scope-resolution model dropped the namespace from def.qualifiedName
// (`A.Inner` not `NS.A.Inner`), so resolveDefGraphId missed the namespaced node
// key and fell back to simpleKey('Inner'), collapsing both bases — DB lost its
// EXTENDS edge. The shipped same-tail fixture is top-level only (no namespace),
// so it cannot catch this.
namespace NS {
struct A {
  struct Inner {
    void from_a() {}
  };
};
struct B {
  struct Inner {
    void from_b() {}
  };
};
struct DA : A::Inner {};
struct DB : B::Inner {};
}  // namespace NS
