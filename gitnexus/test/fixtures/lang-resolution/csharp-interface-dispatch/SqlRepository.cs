public class SqlRepository : IRepository {
    public string Find(int id) {
        return "found";
    }

    public bool Save(string entity) {
        return true;
    }
}
