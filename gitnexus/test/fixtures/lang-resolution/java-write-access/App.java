import models.User;
import models.Address;

public class App {
    public static void updateUser(User user) {
        user.name = "Alice";
        user.address = new Address();
    }
}
