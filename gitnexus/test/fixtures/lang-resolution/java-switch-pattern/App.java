import models.User;
import models.Repo;

public class App {
    public static void processAny(Object obj) {
        switch (obj) {
            case User user -> user.save();
            case Repo repo -> repo.save();
            default -> {}
        }
    }

    public static void handleUser(Object obj) {
        switch (obj) {
            case User user -> user.save();
            default -> {}
        }
    }
}
