using Models;
using System.Collections.Generic;

namespace App;

public class AppService
{
    public void ProcessEntities(List<User> users, List<Repo> repos)
    {
        foreach (User user in users)
        {
            user.Save();
        }
        foreach (Repo repo in repos)
        {
            repo.Save();
        }
    }
}
