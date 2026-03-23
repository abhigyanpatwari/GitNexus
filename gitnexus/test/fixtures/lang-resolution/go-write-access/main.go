package main

type Address struct {
	City string
}

type User struct {
	Name    string
	Address Address
}

func updateUser(user *User) {
	user.Name = "Alice"
	user.Address = Address{City: "NYC"}
}
