public class SqlRepository implements Repository {
    public String find(int id) {
        return "found-by-id";
    }

    public String find(String name, boolean exact) {
        return "found-by-name";
    }

    public void save(String data) {
        System.out.println(data);
    }
}
