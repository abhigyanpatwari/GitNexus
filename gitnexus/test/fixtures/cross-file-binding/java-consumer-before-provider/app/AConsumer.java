package app;

import static models.BProvider.getUser;

public class AConsumer {
    public void run() {
        var u = getUser();
        u.save();
    }
}
