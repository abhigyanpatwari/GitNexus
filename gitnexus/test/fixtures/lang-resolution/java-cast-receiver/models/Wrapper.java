package models;

public class Wrapper {
    public void open() {
        // decoy: same-named method on obj's DECLARED type — a regression
        // that ignores the cast would resolve here instead of Box.open
    }
}
