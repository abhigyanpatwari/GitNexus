class Families {
    void number() {}
    void text() {}

    <T extends Number> void choose(T... values) { number(); }
    <T extends CharSequence> void choose(T... values) { text(); }
}
