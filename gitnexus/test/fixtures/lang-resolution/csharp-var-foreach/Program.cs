using Models;
using System.Collections.Generic;

namespace App;

public class AppService
{
    public void ProcessUsers(List<User> users)
    {
        foreach (var user in users)
        {
            user.Save();
        }
    }

    public void ProcessRepos(List<Repo> repos)
    {
        foreach (var repo in repos)
        {
            repo.Save();
        }
    }

    public void Direct(User u, Repo r)
    {
        u.Save();
        r.Save();
    }
}
