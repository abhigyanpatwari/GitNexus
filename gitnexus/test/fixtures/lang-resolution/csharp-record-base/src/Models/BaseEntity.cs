namespace Models;

public record BaseEntity(int EntityId)
{
    public virtual bool Save() { return true; }
}
