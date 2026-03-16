package services;

import models.User;
import models.Repo;

public class App {
    public void process(Object obj) {
        if (obj instanceof User user) {
            user.save();
        }
    }
}
