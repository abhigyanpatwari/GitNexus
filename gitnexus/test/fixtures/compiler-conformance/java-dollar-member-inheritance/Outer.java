package fixtures;

class Top$1 {
    int price() { return 1; }
}

class Outer {
    static class Inner$1Name extends Top$1 {
        int price(int units) { return units; }
    }
    static class Outer$1Local {
        class Nested$2 extends Inner$1Name {
            int total() { return price(2); }
        }
    }

    void make() {
        class Worker {
            class Member$3 extends Inner$1Name {
                int total() { return price(); }
            }
        }
        Object anonymous = new Object() {
            class Member$4 extends Inner$1Name {
                int total() { return price(4); }
            }
        };
    }
}
