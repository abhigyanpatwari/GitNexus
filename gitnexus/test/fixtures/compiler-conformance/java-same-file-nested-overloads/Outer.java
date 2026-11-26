class Outer {
    private static class Inner {}
    static class Other { static class Inner {} }

    static int select(Outer.Inner value) { return 1; }
    static int select(Outer.Other.Inner value) { return 2; }
    static int select(Object value) { return 3; }

    static int inside(Outer.Inner first, Outer.Other.Inner second) {
        return select(first) + select(second);
    }
}

class Sibling {
    int outside(Outer.Other.Inner value) {
        return Outer.select(value);
    }
}

class Parent {
    static class Outer { static class Other { static class Inner {} } }
}

class Choose {
    static int pick(Outer.Other.Inner value) { return 1; }
    static int pick(Parent.Outer.Other.Inner value) { return 2; }
}

class Child extends Parent {
    int inherited(Outer.Other.Inner value) {
        return Choose.pick(value);
    }
}
