public class DbLookup implements ILookup {
    public String find(int id) {
        return "by-id";
    }

    public String find(String name) {
        return "by-name";
    }
}
