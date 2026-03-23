package models

type City struct {
	Name string
}

func (c *City) GetName() string {
	return c.Name
}

type Address struct {
	City   City
	Street string
}

func (a *Address) Save() {
}

type User struct {
	Name    string
	Address Address
}

func (u *User) GetAddress() *Address {
	return &u.Address
}

type UserService struct{}

func (s *UserService) GetUser() *User {
	return &User{}
}
