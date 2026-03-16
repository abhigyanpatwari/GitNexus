namespace CSharpAsyncBinding;

public class UserService
{
    public async Task<User> GetUserAsync(string name)
    {
        return new User { Name = name };
    }
}
