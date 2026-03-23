using Models;

namespace Services
{
    public class UserService
    {
        public void ProcessUser()
        {
            var user = new User();
            user.Save();
        }
    }
}
