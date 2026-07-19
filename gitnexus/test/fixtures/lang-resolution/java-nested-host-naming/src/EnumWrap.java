public class EnumWrap {
    enum Mode {
        ON;

        public void install() {
            Runnable r = new Runnable() {
                public void run() {
                    System.out.println("nested anon");
                }
            };
            r.run();
        }
    }
}
