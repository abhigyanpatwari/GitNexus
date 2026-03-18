import models.User;
import models.Repo;

public class Main {
    void processUsers() {
        for (User user : User.getUsers()) {
            user.save();
        }
    }

    void processRepos() {
        for (Repo repo : Repo.getRepos()) {
            repo.save();
        }
    }
}
