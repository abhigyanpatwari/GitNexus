package models;

public class User extends BaseModel<String> {
    public boolean save() {
        super.save();
        return true;
    }
}
