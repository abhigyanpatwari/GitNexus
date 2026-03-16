package main

import "example.com/multireturn/models"

func NewUser(name string) (*models.User, error) {
	return &models.User{Name: name}, nil
}

func NewRepo(name string) (*models.Repo, error) {
	return &models.Repo{Name: name}, nil
}

func processUser() {
	user, err := NewUser("alice")
	if err != nil {
		return
	}
	user.Save()
}

func processRepo() {
	repo, _ := NewRepo("main")
	repo.Save()
}
