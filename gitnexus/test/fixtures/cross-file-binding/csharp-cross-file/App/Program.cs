using static CrossFile.Models.UserFactory;

namespace CrossFile.App
{
    public class Program
    {
        public void Run()
        {
            var u = GetUser();
            u.Save();
            u.GetName();
        }
    }
}
