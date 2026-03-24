using Grandparent.Models;

namespace Grandparent.Services
{
    public class App
    {
        public void Process()
        {
            var c = new C();
            c.Greet().Save();
        }
    }
}
