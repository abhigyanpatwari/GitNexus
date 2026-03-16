package main

type User struct {
	Name string
}

func (u *User) Save() bool {
	return true
}

type Repo struct {
	URL string
}

func (r *Repo) Persist() bool {
	return true
}
