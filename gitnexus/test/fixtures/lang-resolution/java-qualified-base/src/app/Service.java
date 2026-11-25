package app;

// Both written names resolve to source declarations in app.base.
public class Service extends app.base.Box<String> implements app.base.IFoo<String> {
    public void foo(String t) {}
}
