using Models;

namespace App;

public class AppService
{
    public void Process()
    {
        User? user = new User();
        Repo? repo = new Repo();

        // Null-conditional calls — nullable receiver should be unwrapped
        user?.Save();
        repo?.Save();
    }
}
