package models;

public class UserService {
    public User lookup(int id) {
        return new User();
    }

    public User lookup(String name) {
        return new User();
    }

    public void run() {
        lookup(42);        // literal int → should disambiguate to lookup(int)
        lookup("alice");   // literal String → should disambiguate to lookup(String)
    }
}
