package models

type City struct {
	ZipCode string
}

func (c *City) GetName() string {
	return "city"
}

type Address struct {
	City   City
	Street string
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
