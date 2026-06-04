namespace Models;

public record UserRecord(int Id) : BaseEntity(Id)
{
    public override bool Save()
    {
        base.Save();
        return true;
    }
}
