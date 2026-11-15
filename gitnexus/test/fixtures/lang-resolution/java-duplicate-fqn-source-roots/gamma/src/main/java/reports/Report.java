package reports;

import models.User;

public class Report {
    public void run(User user) {
        user.save();
    }
}
