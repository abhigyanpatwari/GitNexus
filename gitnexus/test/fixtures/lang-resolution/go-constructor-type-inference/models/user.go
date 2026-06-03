package models

type User struct{}

func (u *User) Save() bool {
	return true
}

type Box[T any] struct {
	Value T
}
