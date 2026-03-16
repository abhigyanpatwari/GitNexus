using Models;

namespace App;

public class Program
{
    static User GetUser() => new User();
    static Repo GetRepo() => new Repo();

    public static void ProcessEntities()
    {
        User u = GetUser();
        var alias = u;
        alias.Save();

        Repo r = GetRepo();
        var rAlias = r;
        rAlias.Save();
    }
}
