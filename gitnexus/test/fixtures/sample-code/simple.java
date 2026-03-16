public class UserService {
    private String name;

    public UserService(String name) {
        this.name = name;
    }

    public String getName() {
        return this.name;
    }

    private void reset() {
        this.name = "";
    }
}
