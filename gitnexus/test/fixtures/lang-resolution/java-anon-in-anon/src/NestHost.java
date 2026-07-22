public class NestHost {
    public void make() {
        Runnable outer = new Runnable() {
            public void run() {
                Runnable inner = new Runnable() {
                    public void run() {
                        System.out.println("inner");
                    }
                };
                inner.run();
            }
        };
        outer.run();
    }
}
