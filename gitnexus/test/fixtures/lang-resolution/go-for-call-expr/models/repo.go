package models

type Repo struct {
	Name string
}

func (r *Repo) Save() error {
	return nil
}

func GetRepos() []Repo {
	return []Repo{{Name: "main"}}
}
