package models;

// All classes in same file so parentMap captures the extends relationship

class Animal {
    public String speak() {
        return "...";
    }
}

class Dog extends Animal {
    public String speak() {
        return "woof";
    }

    public String fetchBall() {
        return "ball";
    }
}

public class App {
    public void run() {
        // Virtual dispatch: declared as Animal, constructed as Dog
        Animal animal = new Dog();
        animal.fetchBall();  // Only Dog has fetchBall — proves virtual dispatch override

        // Direct type: no override needed
        Dog dog = new Dog();
        dog.fetchBall();     // Direct resolution to Dog#fetchBall
    }
}
