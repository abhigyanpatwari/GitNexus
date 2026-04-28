package app;

import models.Animal;
import models.Dog;

public class App {
    public static void main(String[] args) {
        Dog dog = new Dog();
        String sound = dog.speak();
        String category = Animal.classify("dog");
    }
}
