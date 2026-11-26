package client;

import java.lang.annotation.ElementType;
import java.lang.annotation.Target;
import static api.ChildOuter.Inner;
import static api.Outer.Inner;

@Target(ElementType.TYPE_USE)
@interface Mark { String value(); }

class Base { public int price() { return 2; } }

class Imported extends Inner.Base {
    int run() { return price(); }
}

class Bounded<T extends api.Outer.@Mark("/*") Inner> {
    class Child extends T.Base {
        int run() { return price(); }
    }
}
