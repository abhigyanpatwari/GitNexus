namespace Models;

public class User
{
    public string GetName() => "user";
}

public class UserService
{
    public User Lookup(int id)
    {
        return new User();
    }

    public User Lookup(string name)
    {
        return new User();
    }

    public void Run()
    {
        Lookup(42);        // literal int → should disambiguate to Lookup(int)
        Lookup("alice");   // literal string → should disambiguate to Lookup(string)
    }
}
