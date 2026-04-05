package models;

public class UserService {
    public User lookup(int id) {
        return new User();
    }

    public User lookup(String name) {
        return new User();
    }

    public void callById() {
        lookup(42);        // literal int → must resolve to lookup(int) only
    }

    public void callByName() {
        lookup("alice");   // literal String → must resolve to lookup(String) only
    }
}
