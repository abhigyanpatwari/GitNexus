class App {
    static void Main() {
        var dog = new Dog();
        var sound = dog.Speak();
        var category = Animal.Classify("dog");
    }
}
