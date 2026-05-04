package main

func NewUser() *User {
	return &User{}
}

func processUser() {
	user := NewUser()
	user.Save()
}
