interface Reader {
    void read(String value);
}

interface Identity {
    <T> T value(T input);
}

class Parent {
    public void read(String value) {}
}

class Child extends Parent implements Reader, Identity {
    public <T> T value(T input) { return input; }
}

class Grandchild extends Child {}
