package main

import "example.com/go-constructor-type-inference/models"

func processEntities() {
	user := models.User{}
	repo := models.Repo{}
	user.Save()
	repo.Save()
}
