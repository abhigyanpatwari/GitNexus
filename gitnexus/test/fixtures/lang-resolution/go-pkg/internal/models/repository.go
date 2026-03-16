package models

type Repository interface {
	Save(user *User) error
	FindByID(id int) (*User, error)
}
