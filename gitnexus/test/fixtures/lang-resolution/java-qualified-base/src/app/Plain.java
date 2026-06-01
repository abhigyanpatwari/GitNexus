package app;

// Qualified non-generic bases: `extends app.base.Base` and `implements
// app.base.IBar` (both bare scoped_type_identifier, no type arguments).
public class Plain extends app.base.Base implements app.base.IBar {
    public void bar() {}
}
