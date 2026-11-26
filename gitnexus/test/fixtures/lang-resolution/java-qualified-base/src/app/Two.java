package app;

// Type arguments preserve the package qualifier. Javac reports the same
// missing package for both of these generic bases as it does for Plain.
public class Two extends base.Box<String> implements base.IFoo<String> {
    public void foo(String t) {}
}
