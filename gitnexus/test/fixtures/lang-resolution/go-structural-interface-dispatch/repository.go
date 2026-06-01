package main

type User struct {
	Name string
}

type Repository interface {
	Find(id string) User
	Save(user User) error
}

type SqlRepository struct{}

func (s SqlRepository) Find(id string) User {
	return User{Name: id}
}

func (s SqlRepository) Save(user User) error {
	return nil
}

type MemoryRepository struct{}

func (m MemoryRepository) Find(id string) User {
	return User{Name: id}
}

func (m MemoryRepository) Save(user User) error {
	return nil
}

type BadRepository struct{}

func (b BadRepository) Find(id string) User {
	return User{Name: id}
}

func (b BadRepository) Save(id string) error {
	return nil
}

func precise(user User) {
	var repo Repository = SqlRepository{}
	repo.Save(user)
}

func fallback(repo Repository, user User) {
	repo.Save(user)
}

type Reader interface {
	Read() error
}

type ReadCloser interface {
	Reader
	Close() error
}

type File struct{}

func (f File) Read() error {
	return nil
}

func (f File) Close() error {
	return nil
}

type CloseOnly struct{}

func (c CloseOnly) Close() error {
	return nil
}

func fallbackReadCloser(rc ReadCloser) {
	rc.Close()
}

type PointerOnly interface {
	Touch()
}

type PointerOnlyThing struct{}

func (p *PointerOnlyThing) Touch() {}
