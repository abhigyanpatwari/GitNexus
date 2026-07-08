package store

import (
	apix "github.com/example/gostruct/api"
	"github.com/example/gostruct/other"
)

type GoodStore struct{}

func (s GoodStore) Load(id string) apix.User {
	return apix.User{ID: id}
}

func (s GoodStore) Save(user apix.User) error {
	return nil
}

type WrongStore struct{}

func (s WrongStore) Load(id string) other.User {
	return other.User{ID: id}
}

func (s WrongStore) Save(user other.User) error {
	return nil
}
