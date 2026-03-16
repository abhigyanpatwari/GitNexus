using Models;

public class App
{
    public void Run()
    {
        // Explicit new
        var user = new User("Alice", 30);
        user.Save();

        // Target-typed new (C# 9)
        User user2 = new("Bob", 25);
        user2.Save();
    }
}
