class V {
    V(String... values) {}
    V(int... values) {}
}

class W extends V {
    W() { this(1); }
    W(int value) { super(7); }
    W(String value) { super(value); }
}

class Construction {
    V number() { return new V(3); }
    V text() { return new V("a"); }
    V array(int[] values) { return new V(values); }
    V ambiguous() { return new V(); }
    V inapplicable() { return new V(true); }
}
