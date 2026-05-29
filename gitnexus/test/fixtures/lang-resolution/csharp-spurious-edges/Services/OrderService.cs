using System.Threading.Tasks;
using MyApp.Models;

namespace MyApp.Services;

public class OrderService
{
    public Task ProcessAsync()
    {
        var user = new User();
        return Task.CompletedTask;
    }
}
