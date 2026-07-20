public class Base {
    public void log() {
        System.out.println("base log");
    }
}

class Sub extends Base {
    public void go() {
        log();
    }
}
