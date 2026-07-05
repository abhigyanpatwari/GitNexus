package main

import "example.com/go-constructor-type-inference/models"

func processEntities() {
	user := models.User{}
	repo := models.Repo{}
	box := models.Box[models.User]{}
	user.Save()
	repo.Save()
	_ = box
}
