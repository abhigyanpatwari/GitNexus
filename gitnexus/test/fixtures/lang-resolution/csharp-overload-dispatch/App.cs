public class App {
    public void Run() {
        var repo = new SqlRepository();
        repo.Find(42);
        repo.Find("alice", true);
        repo.Save("test");
    }
}
