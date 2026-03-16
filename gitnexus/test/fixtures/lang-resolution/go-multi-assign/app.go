package main

func process(name string, url string) {
	user, repo := User{Name: name}, Repo{URL: url}
	user.Save()
	repo.Persist()
}
