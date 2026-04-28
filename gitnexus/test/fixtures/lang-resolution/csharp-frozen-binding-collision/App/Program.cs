using Collision.Models;

namespace Collision.App
{
    public class User
    {
        public string GetName() { return "app"; }
    }

    public class Program
    {
        public void Run()
        {
            var u = new User();
            u.GetName();
        }
    }
}
