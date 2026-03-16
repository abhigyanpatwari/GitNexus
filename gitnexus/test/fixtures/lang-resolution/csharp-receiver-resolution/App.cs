using Models;

namespace App;

public class AppService
{
    public void ProcessEntities()
    {
        User user = new User();
        Repo repo = new Repo();
        user.Save();
        repo.Save();
    }
}
