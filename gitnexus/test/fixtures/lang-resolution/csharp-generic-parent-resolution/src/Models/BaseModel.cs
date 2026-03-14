namespace Models;

public class BaseModel<T> {
    public virtual bool Save() { return true; }
}
