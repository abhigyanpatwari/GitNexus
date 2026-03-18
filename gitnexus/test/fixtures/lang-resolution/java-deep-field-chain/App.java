import models.User;

public class App {
    public static void processUser(User user) {
        // 2-level chain: user.address → Address, then .save() → Address#save
        user.address.save();

        // 3-level chain: user.address → Address, .city → City, .getName() → City#getName
        user.address.city.getName();
    }
}
