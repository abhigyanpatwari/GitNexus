import services.UserService;

public class App {
    public static void processUser() {
        UserService svc = new UserService();
        var user = svc.getUser("alice");
        user.save();
    }
}
