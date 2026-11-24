package pricing;

class Outer {
    private static class Base {
        int price() { return 1; }
    }

    static class Family {
        static class Base {
            int price() { return 2; }
        }

        static class Child extends pricing.Outer.Base {
            int total() { return price(); }
        }
    }
}
