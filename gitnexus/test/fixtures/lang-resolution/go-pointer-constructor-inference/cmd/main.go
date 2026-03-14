package main

import "example.com/pointer-test/models"

func process() {
	user := &models.User{Name: "alice"}
	user.Save()

	repo := &models.Repo{Name: "test"}
	repo.Save()
}
