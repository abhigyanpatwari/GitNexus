package models

type Address struct {
	City string
}

func (a *Address) Save() bool {
	return true
}

type User struct {
	Name    string
	Address Address
}

func (u *User) Greet() string {
	return u.Name
}
