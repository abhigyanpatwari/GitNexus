namespace ReturnType.Models;

public class User
{
    private string _name;

    public User(string name)
    {
        _name = name;
    }

    public bool Save()
    {
        return true;
    }
}

public class UserService
{
    public User GetUser(string name)
    {
        return new User(name);
    }
}
