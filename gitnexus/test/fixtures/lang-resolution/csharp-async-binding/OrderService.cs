namespace CSharpAsyncBinding;

public class OrderService
{
    public async Task<User> GetUserAsync(string name)
    {
        return new User { Name = name };
    }
}
