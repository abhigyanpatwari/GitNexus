public class SqlRepository : IRepository {
    public string Find(int id) {
        return "found-by-id";
    }
    public string Find(string name, bool exact) {
        return "found-by-name";
    }
    public void Save(string data) {
        Console.WriteLine(data);
    }
}
