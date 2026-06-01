namespace Models;

public record UserRecord(string Name) : Models.BaseEntity(Name), Contracts.IAuditable
{
    public override bool Save()
    {
        base.Save();
        return true;
    }
}
