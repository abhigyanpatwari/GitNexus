import models.User;
import models.Repo;

// Tests that Optional<User> unwraps to User in TypeEnv,
// so assignment chains from Optional-typed sources resolve correctly.
public class App {
    static User findUser() { return new User(); }
    static Repo findRepo() { return new Repo(); }

    static void processEntities() {
        // Optional<User> declared — TypeEnv stores "User" (not "Optional")
        // The alias then propagates User through the chain
        java.util.Optional<User> opt = java.util.Optional.of(findUser());
        User user = opt.get();
        user.save();

        Repo repo = findRepo();
        repo.save();
    }
}
