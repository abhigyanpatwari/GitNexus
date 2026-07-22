public enum M3 {
    A {
        public void hook() {
            base();
        }
    },
    C {
        public void hook() {
            log();
        }
    };

    public abstract void hook();

    public void base() {
        System.out.println("base");
    }

    public void log() {
        System.out.println("log");
    }
}
