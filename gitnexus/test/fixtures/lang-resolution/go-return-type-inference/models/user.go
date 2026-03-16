package models

type User struct {
	Name string
}

func (u *User) Save() bool {
	return true
}

func NewUser(name string) *User {
	return &User{Name: name}
}
