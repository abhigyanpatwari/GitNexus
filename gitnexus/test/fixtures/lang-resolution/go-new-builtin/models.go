package main

type User struct {
	Name string
	Age  int
}

func (u *User) Save() {}
func (u *User) Greet() string {
	return "Hello, " + u.Name
}
