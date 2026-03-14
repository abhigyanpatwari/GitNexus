namespace Models;

public class User : BaseModel {
    public override bool Save() {
        base.Save();
        return true;
    }
}
