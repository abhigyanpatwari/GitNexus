package main

import "example.com/go-nullable-receiver/models"

func findUser() *models.User {
	return &models.User{}
}

func findRepo() *models.Repo {
	return &models.Repo{}
}

func processEntities() {
	var user *models.User = findUser()
	var repo *models.Repo = findRepo()
	user.Save()
	repo.Save()
}
