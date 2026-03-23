public class Greeter {
    public string Greet(string name, string greeting = "Hello") {
        return greeting + ", " + name;
    }
}

public class Program {
    public static void Main() {
        var g = new Greeter();
        g.Greet("Alice");
        g.Greet("Bob", "Hi");
    }
}
