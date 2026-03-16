package services;

import models.User;
import interfaces.Serializable;

public class UserService {
    public void processUser(User user) {
        user.validate();
        user.save();
        String data = user.serialize();
    }
}
