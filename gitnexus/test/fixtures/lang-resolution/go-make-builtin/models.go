package main

type User struct {
	Name string
}

func (u *User) Save() {}
func (u *User) Greet() string {
	return "Hello, " + u.Name
}
