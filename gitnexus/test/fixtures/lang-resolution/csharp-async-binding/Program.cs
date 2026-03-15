namespace CSharpAsyncBinding;

public class Program
{
    public static async Task Main(string[] args)
    {
        var userSvc = new UserService();
        var orderSvc = new OrderService();
        await ProcessUser(userSvc);
        await ProcessOrder(orderSvc);
    }

    public static async Task ProcessUser(UserService userSvc)
    {
        var user = await userSvc.GetUserAsync("alice");
        user.Save();
    }

    public static async Task ProcessOrder(OrderService orderSvc)
    {
        var order = await orderSvc.GetOrderAsync("bob");
        order.Save();
    }
}
