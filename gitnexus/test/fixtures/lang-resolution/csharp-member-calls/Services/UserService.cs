using Models;

namespace Services;

public class UserService
{
    public bool ProcessUser()
    {
        var user = new User();
        return user.Save();
    }
}
