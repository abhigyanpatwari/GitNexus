using ReturnType.Models;

namespace ReturnType.Services;

public class App
{
    public void Run()
    {
        var svc = new UserService();
        var user = svc.GetUser("alice");
        user.Save();
    }
}
