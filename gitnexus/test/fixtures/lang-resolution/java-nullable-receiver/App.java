import models.User;
import models.Repo;

public class App {
    public static void processEntities() {
        User user = findUser();
        Repo repo = findRepo();
        user.save();
        repo.save();
    }

    private static User findUser() {
        return new User();
    }

    private static Repo findRepo() {
        return new Repo();
    }
}
