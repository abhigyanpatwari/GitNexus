namespace Models;

public record BaseEntity
{
    public virtual bool Save() { return true; }
}
