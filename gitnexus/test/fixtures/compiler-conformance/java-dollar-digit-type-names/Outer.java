package fixtures;

class Top$1 {}

class Outer {
    static class Inner$1Name extends Top$1 {}
    static class Outer$1Local {
        class Nested$2 extends Inner$1Name {}
    }

    void make() {
        class Worker {
            class Member$3 extends Inner$1Name {}
        }
        Object anonymous = new Object() {
            class Member$4 extends Inner$1Name {}
        };
    }
}
