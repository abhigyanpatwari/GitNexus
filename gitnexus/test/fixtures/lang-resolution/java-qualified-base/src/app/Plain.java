package app;

// The package base is absent. The declarations in app.base have the same
// simple names, so selecting either one here would create a false edge.
public class Plain extends base.Base implements base.IBar {
    public void bar() {}
}
