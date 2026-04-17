package models

type User struct{}

func (u User) Save() {}

func GetUser() User {
	return User{}
}
