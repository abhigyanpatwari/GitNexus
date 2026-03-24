package models

type City struct {
	Name string
}

func (c *City) Save() bool {
	return true
}

type Address struct {
	City City
}

func (a *Address) GetCity() *City {
	return &a.City
}

type User struct {
	Address Address
}
