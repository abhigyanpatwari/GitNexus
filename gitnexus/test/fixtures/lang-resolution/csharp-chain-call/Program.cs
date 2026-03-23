using ChainCall.Services;

public class App
{
    public void ProcessUser()
    {
        var svc = new UserService();
        svc.GetUser().Save();
    }
}
