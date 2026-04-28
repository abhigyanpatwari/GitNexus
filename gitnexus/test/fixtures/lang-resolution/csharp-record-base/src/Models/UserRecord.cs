namespace Models;

public record UserRecord : BaseEntity
{
    public override bool Save()
    {
        base.Save();
        return true;
    }
}
