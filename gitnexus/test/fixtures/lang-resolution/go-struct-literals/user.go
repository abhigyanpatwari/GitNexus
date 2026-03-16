package main

type User struct {
	Name string
}

func (u *User) Save() bool {
	return true
}
