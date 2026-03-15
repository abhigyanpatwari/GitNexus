namespace CSharpAsyncBinding;

public class Program
{
    public static async Task Main(string[] args)
    {
        var userSvc = new UserService();
        var orderSvc = new OrderService();

        var user = await userSvc.GetUserAsync("alice");
        user.Save();

        var order = await orderSvc.GetUserAsync("bob");
        order.Save();
    }
}
