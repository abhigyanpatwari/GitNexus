package services;

import models.User;

public class UserService {
    public boolean processUser() {
        User user = new User();
        return user.save();
    }
}
