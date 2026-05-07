namespace App;

public class USER_INFO
{
    public string? USER_ID { get; set; }
}

public interface IEntityTypeConfiguration<T>
{
}

public class UserInfoConfiguration : IEntityTypeConfiguration<USER_INFO>
{
    public Task<List<USER_INFO>> Load(List<USER_INFO> users)
    {
        return Task.FromResult(users);
    }
}
