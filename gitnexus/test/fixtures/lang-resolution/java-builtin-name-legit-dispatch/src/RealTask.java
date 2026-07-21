public class RealTask implements Runnable {
    public void run() {
        System.out.println("real task");
    }

    public void trigger() {
        run();
    }
}
