public class Worker {
    public void process() {
        run();
    }

    public void makeHandler() {
        Runnable handler = new Runnable() {
            public void run() {
                System.out.println("handling");
            }
        };
        handler.run();
    }
}
