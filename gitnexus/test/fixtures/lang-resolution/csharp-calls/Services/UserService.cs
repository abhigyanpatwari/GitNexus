using static CallProj.Utils.OneArg;
using static CallProj.Utils.ZeroArg;

namespace CallProj.Services
{
    public class UserService
    {
        public void CreateUser()
        {
            WriteAudit("hello");
        }
    }
}
