package models;

public class Fallback {
    public void act() {
        // obj's OWN declared type — the deliberate fallback target for a
        // cast to an unindexed simple type: ((String) obj).act()
    }
}
