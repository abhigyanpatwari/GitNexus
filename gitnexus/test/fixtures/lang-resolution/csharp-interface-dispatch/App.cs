public class App {
    public static void Main() {
        IRepository repo = new SqlRepository();
        repo.Find(1);
        repo.Save("test");
    }
}
