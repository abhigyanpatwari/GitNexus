namespace Demo;

public class Greeter
{
    public string Greet(string name) => $"Hello, {name}!";

    public static void Main(string[] args)
    {
        var g = new Greeter();
        System.Console.WriteLine(g.Greet("world"));
    }
}

public interface IFoo
{
    void Bar();
}
