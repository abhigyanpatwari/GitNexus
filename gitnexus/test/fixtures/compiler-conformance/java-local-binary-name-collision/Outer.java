class Outer$1Foo {
    int price() { return 1; }
}

class Outer {
    int total(Outer$1Foo literal) {
        class Foo { int price() { return 2; } }
        var special = new Object() { int price() { return 3; } };
        return literal.price() + new Foo().price() + special.price();
    }
}

class Outer$1 {}
