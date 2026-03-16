import models.User;
import models.Repo;

public class App {
    static User getUser() { return new User(); }
    static Repo getRepo() { return new Repo(); }

    public static void processEntities() {
        User u = getUser();
        var alias = u;
        alias.save();

        Repo r = getRepo();
        var rAlias = r;
        rAlias.save();
    }
}
