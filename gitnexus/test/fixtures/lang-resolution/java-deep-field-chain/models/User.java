package models;

public class User {
    public String name;
    public Address address;

    public String greet() {
        return this.name;
    }
}
