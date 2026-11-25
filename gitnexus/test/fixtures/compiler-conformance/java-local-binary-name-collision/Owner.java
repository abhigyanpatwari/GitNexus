class Owner {
    Object first = new Object() {
        class Foo { int price() { return 1; } }
    };

    int total() {
        class $Foo { int price() { return 2; } }
        return new $Foo().price();
    }
}
