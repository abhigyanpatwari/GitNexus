namespace InterfaceDefault;

public class User : IValidator
{
    public string Name { get; }

    public User(string name)
    {
        Name = name;
    }
}
