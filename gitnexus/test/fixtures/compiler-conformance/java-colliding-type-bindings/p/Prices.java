package p;

@interface First {
    class Value {
        int price() { return 1; }
    }
}

@interface Second {
    class Value {
        int price() { return 2; }
    }
}

class Prices {
    int sum(First.Value first, Second.Value second) {
        return first.price() + second.price();
    }
}
