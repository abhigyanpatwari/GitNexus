import services.UserService;
import models.User;

public class App {
    public static void processWithService(UserService svc) {
        svc.getUser().address.save();
    }

    public static void processWithUser(User user) {
        user.getAddress().city.getName();
    }
}
