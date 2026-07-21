public class Multi {
    public void first() {
        Runnable a = new Runnable() {
            public void run() {
                System.out.println("first");
            }
        };
        a.run();
    }

    public void second() {
        Runnable b = new Runnable() {
            public void run() {
                System.out.println("second");
            }
        };
        b.run();
    }
}
