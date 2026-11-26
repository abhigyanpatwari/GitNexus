package app;

import static models.UserFactory.getUser;

public class App {
    public void run() {
        var user = getUser();
        user.save();
        user.getName();
    }
}
