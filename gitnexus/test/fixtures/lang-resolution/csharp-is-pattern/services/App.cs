using IsPattern.Models;

namespace IsPattern.Services;

public class App
{
    public void Process(object obj)
    {
        if (obj is User user)
        {
            user.Save();
        }
    }
}
