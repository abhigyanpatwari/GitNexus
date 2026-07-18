public class Base {
    public void work() {
        System.out.println("base work");
    }
}

class AnonExtHost {
    public void make() {
        Base b = new Base() {
            public void extra() {
                work();
            }
        };
        b.extra();
    }
}
