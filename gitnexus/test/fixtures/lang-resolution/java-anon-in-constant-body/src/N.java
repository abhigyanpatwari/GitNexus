public enum N {
    A {
        public void m() {
            Runnable r = new Runnable() {
                public void run() {
                    System.out.println("nested in constant");
                }
            };
            r.run();
        }
    };

    public abstract void m();
}
