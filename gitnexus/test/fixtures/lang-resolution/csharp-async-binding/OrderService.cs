namespace CSharpAsyncBinding;

public class OrderService
{
    public async Task<Order> GetOrderAsync(string name)
    {
        return new Order { Name = name };
    }
}
