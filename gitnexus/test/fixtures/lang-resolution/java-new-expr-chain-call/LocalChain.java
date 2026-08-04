package probe;

public class LocalChain {
    void m() {
        class Local {
            void inner() {
                System.out.println("right target");
            }
        }
        new Local().inner();
    }
}
