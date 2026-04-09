namespace InterfaceDefault;

public class App
{
    public static void Run()
    {
        User user = new User("alice");
        user.Validate();
    }
}
