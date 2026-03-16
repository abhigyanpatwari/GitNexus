import models.User;
import models.Repo;

public class App {
    public static void processEntities() {
        User user = new User();
        Repo repo = new Repo();
        user.save();
        repo.save();
    }
}
