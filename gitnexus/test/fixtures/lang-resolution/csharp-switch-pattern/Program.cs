using Models;

namespace App;

public class AppService
{
    public void Process(object obj)
    {
        if (obj is User user)
        {
            user.Save();
        }

        switch (obj)
        {
            case Repo repo:
                repo.Save();
                break;
        }
    }
}
