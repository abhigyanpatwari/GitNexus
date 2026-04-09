namespace InterfaceDefault;

public class App
{
    public static void Run()
    {
        // Default interface methods in C# 8.0+ are reachable ONLY through
        // the interface type, not as inherited class members. Declaring the
        // variable as IValidator is the idiomatic way to invoke Validate().
        // `User user = new User(...); user.Validate();` would be a compile
        // error because User does not expose Validate as a class member.
        IValidator user = new User("alice");
        user.Validate();
    }
}
