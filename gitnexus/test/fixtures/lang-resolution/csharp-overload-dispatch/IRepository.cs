public interface IRepository {
    string Find(int id);
    string Find(string name, bool exact);
    void Save(string data);
}
