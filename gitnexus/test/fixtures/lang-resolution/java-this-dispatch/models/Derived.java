package models;

public class Derived extends Base {
    public String greet(String name, int times) {
        return name + times;
    }

    public String announce() {
        return this.greet("world");
    }
}
