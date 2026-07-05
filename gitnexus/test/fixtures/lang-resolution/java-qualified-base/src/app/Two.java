package app;

// 2-SEGMENT qualified-GENERIC bases: `extends base.Box<String>` and `implements
// base.IFoo<String>`. Exercises the generic_type-wrapped scoped arms at two
// segments (the shape that double-matched before the end-anchor fix). Pairs with
// Plain (2-segment plain) and Service (3-segment generic) for full arm coverage.
public class Two extends base.Box<String> implements base.IFoo<String> {
    public void foo(String t) {}
}
