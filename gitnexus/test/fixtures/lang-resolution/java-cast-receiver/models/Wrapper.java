package models;

public class Wrapper {
    public void open() {
        // decoy: same-named method on obj's DECLARED type — a regression
        // that ignores the cast would resolve here instead of Box.open
    }

    public void act2() {
        // decoy for the array cast ((Box[]) obj).act2(): an unparseable
        // cast that falls through to obj's declared type resolves here
    }

    public void act3() {
        // decoy for the fully-qualified cast ((models.Box) obj).act3():
        // an unparseable cast that falls through resolves here
    }
}
