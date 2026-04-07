public interface IRepository {
    string Find(int id);
    bool Save(string entity);
}
