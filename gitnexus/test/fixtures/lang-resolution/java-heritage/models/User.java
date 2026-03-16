package models;

import interfaces.Serializable;
import interfaces.Validatable;

public class User extends BaseModel implements Serializable, Validatable {
    private String name;

    public String serialize() {
        return name;
    }

    public void deserialize(String data) {
        this.name = data;
    }

    public boolean validate() {
        return name != null;
    }
}
