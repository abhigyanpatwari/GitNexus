public class App {
    static User getUser(String name) {
        return new User(name);
    }

    void processUser() {
        var user = getUser("alice");
        user.save();
    }
}
