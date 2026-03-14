namespace Models;

public class User : BaseModel<string> {
    public override bool Save() {
        base.Save();
        return true;
    }
}
