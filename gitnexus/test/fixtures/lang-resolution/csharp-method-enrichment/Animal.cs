public abstract class Animal {
    public abstract string Speak();

    public static string Classify(string name) {
        return "mammal";
    }

    public bool Breathe() {
        return true;
    }
}

public class Dog : Animal {
    public override string Speak() {
        return "woof";
    }
}
