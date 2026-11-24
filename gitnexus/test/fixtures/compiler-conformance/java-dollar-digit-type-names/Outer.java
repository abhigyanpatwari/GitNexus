package prices;

class Outer {
    static class Outer$1Local {
        int price() { return 1; }
    }

    int total(Outer$1Local member) {
        // javac emits Outer$1Local.class for this local subclass.
        class Local extends Outer$1Local {
            @Override int price() { return 2; }
        }
        Local local = new Local();
        return member.price() + local.price();
    }
}
