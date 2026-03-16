using U = Models.User;
using R = Models.Repo;

namespace Services
{
    public class Main
    {
        public void Run()
        {
            var u = new U("alice");
            var r = new R("https://example.com");
            u.Save();
            r.Persist();
        }
    }
}
