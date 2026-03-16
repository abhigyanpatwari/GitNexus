package models

type Admin struct {
	User
	Role string
}

func NewAdmin(name string, role string) *Admin {
	return &Admin{User: *NewUser(name), Role: role}
}
