package api

type User struct {
	ID string
}

type Saver interface {
	Load(id string) User
	Save(user User) error
}

type Reader interface {
	Read() error
}
