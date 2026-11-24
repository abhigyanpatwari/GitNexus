package p;

import lombok.Getter;

public class Outer {
    public static class Roots {
        public static class Plain {}
        public static class Shadow {
            public @interface Getter { int local(); }
        }
    }

    static class InheritedRoots extends Roots {}

    static class Direct extends Roots.Plain {
        @Getter int price;
    }

    static class Inherited extends InheritedRoots.Plain {
        @Getter int amount;
    }

    static class Blocked extends Roots.Shadow {
        @Getter(local = 1) int hidden;
    }
}
