package main

import "example.com/go-receiver-resolution/models"

func processEntities() {
	var user models.User
	var repo models.Repo
	user.Save()
	repo.Save()
}
