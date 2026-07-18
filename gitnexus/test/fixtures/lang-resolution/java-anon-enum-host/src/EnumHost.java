public enum EnumHost {
    A;

    public void run() {
        System.out.println("enum run");
    }

    public void install() {
        Runnable r = new Runnable() {
            public void run() {
                System.out.println("anon run");
            }
        };
        r.run();
    }

    public void caller() {
        run();
    }
}
