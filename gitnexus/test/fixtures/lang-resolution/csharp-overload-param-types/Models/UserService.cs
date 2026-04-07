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

    public void CallById()
    {
        Lookup(42);        // literal int → must resolve to Lookup(int) only
    }

    public void CallByName()
    {
        Lookup("alice");   // literal string → must resolve to Lookup(string) only
    }
}
