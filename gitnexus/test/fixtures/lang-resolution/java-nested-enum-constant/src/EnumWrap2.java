public class EnumWrap2 {
    enum Mode {
        ON {
            public void hook() {
                System.out.println("nested enum constant body");
            }
        };

        public abstract void hook();
    }
}
