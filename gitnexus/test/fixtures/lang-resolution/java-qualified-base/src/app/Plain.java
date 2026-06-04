package app;

// 2-SEGMENT qualified non-generic bases (Outer.Inner shape): `extends base.Base`
// and `implements base.IBar`. Both segments parse as direct type_identifier
// children of the scoped_type_identifier (no nested prefix), so resolution MUST
// end-anchor to the trailing segment or it double-matches and emits a spurious
// prefix edge. Regression guard for the U2 anchor fix.
public class Plain extends base.Base implements base.IBar {
    public void bar() {}
}
