package services;

import models.User;

public class UserService {
    public void process(User user) {
        user.save();
    }
}
