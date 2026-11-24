package b;

import a.Parent;
import java.lang.Number;

class Family extends a.Parent {
    static class Base {
        int price() { return 2; }
    }

    static class Child extends a.Parent.Base {
        int total() { return price(); }
    }
}

class Middle extends Parent {}

class Descendant extends Middle {
    static class Base {
        int price() { return 3; }
    }

    static class Holder {
        static class Grandchild extends a.Parent.Base {
            int amount() { return price(); }
        }
    }
}

class ShadowedImport {
    static class Number extends a.Parent {}

    static class Branch extends Number {
        static class Base {
            int price() { return 4; }
        }

        static class Leaf extends a.Parent.Base {}
    }
}
