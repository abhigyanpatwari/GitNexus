package models

type User struct {
	Name string
}

func (u *User) Save() error {
	return nil
}

func GetUsers() []User {
	return []User{{Name: "alice"}}
}
