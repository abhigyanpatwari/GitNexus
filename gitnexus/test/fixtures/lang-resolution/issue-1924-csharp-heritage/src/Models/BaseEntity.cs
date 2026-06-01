namespace Models;

public record BaseEntity(string Name)
{
    public virtual bool Save()
    {
        return true;
    }
}
