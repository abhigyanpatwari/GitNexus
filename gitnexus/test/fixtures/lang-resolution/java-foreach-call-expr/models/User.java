package models;

import java.util.List;

public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public void save() {}

    public static List<User> getUsers() {
        return List.of(new User("alice"));
    }
}
