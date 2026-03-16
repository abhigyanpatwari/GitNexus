package models

type Repo struct {
	Name string
}

func (r *Repo) Save() bool {
	return true
}

func GetRepo(name string) *Repo {
	return &Repo{Name: name}
}
