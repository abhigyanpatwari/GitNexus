using MyApp.Models;
using MyApp.Interfaces;

namespace MyApp.Services
{
    public class UserService
    {
        private readonly IRepository _repo;
        private readonly ILogger _logger;

        public void CreateUser(string name)
        {
            var user = new User();
            user.Validate();
            _repo.Save();
            _logger.Log("User created");
        }
    }
}
