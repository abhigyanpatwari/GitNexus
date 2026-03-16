package models

type User struct {
	ID   int
	Name string
}

func NewUser(name string) *User {
	return &User{Name: name}
}
