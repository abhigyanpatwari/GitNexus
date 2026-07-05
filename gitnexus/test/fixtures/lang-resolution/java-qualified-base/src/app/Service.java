package app;

// Qualified-generic bases: `extends app.base.Box<String>` (generic_type wrapping
// a scoped_type_identifier) and `implements app.base.IFoo<String>` (in a
// type_list). Both resolve by their trailing simple name (Box / IFoo).
public class Service extends app.base.Box<String> implements app.base.IFoo<String> {
    public void foo(String t) {}
}
