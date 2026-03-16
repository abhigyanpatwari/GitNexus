using Models;

namespace App;

public class AppService
{
    public void Process()
    {
        User user = new User();
        Repo repo = new Repo();

        // Null-conditional calls — should disambiguate via receiver type
        user?.Save();
        repo?.Save();
    }
}
