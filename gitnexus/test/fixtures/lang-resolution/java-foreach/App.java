import models.User;
import models.Repo;

public class App {
    public static void processEntities(User[] users, Repo[] repos) {
        for (User user : users) {
            user.save();
        }
        for (Repo repo : repos) {
            repo.save();
        }
    }
}
