public class App {
    public void run() {
        SqlRepository repo = new SqlRepository();
        repo.find(42);
        repo.find("alice", true);
        repo.save("test");
    }
}
