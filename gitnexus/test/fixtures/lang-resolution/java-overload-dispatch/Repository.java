public interface Repository {
    String find(int id);
    String find(String name, boolean exact);
    void save(String data);
}
