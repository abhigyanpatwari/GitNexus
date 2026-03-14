package models

type User struct {
    BaseModel
}

func (u *User) Serialize() string {
    return ""
}
