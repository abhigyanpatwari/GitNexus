package services;

import models.User;

public class UserService {
    public User getUser(String name) {
        return new User(name);
    }
}
