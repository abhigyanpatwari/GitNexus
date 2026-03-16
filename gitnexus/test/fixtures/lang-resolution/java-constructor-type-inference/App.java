import models.User;
import models.Repo;

public class App {
    public static void processEntities() {
        var user = new User();
        var repo = new Repo();
        user.save();
        repo.save();
    }
}
