// Same-tail structs nested in sibling NAMED unions (#1995).
//
// `union_specifier` was omitted from cppClassConfig.ancestorScopeNodeTypes, so a
// struct nested in `union U1` and one nested in `union U2` both qualified to the
// bare `Inner` and merged onto ONE Struct:...:Inner node — from_u1 / from_u2
// cross-wired (dangling:0 but wrong). With the union scope qualified they must
// materialize distinct `U1.Inner` / `U2.Inner` nodes.
union U1 {
  struct Inner {
    void from_u1() {}
  };
};
union U2 {
  struct Inner {
    void from_u2() {}
  };
};
