package b;

class Base { public int value() { return 2; } }

class Entry {
    int run() {
        class Local extends a.Base {}
        return new Local().value();
    }

    int after() {
        class First extends a.Base {}
        class a { class Base { int value() { return 3; } } }
        return new First().value();
    }

    int shadowed() {
        class a { static class Base { int value() { return 4; } } }
        class Second extends a.Base {}
        return new Second().value();
    }
}
