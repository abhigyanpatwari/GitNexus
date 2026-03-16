import models.User;

public class App {
    public static void processUser(String name) {
        User user = new User(name);
        user.save();
    }
}
