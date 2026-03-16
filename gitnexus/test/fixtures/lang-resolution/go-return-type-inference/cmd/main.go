package main

import "example.com/returntype/models"

func GetUser(name string) *models.User {
	return &models.User{Name: name}
}

func processUser() {
	user := GetUser("alice")
	user.Save()
}

// Cross-package factory call: models.NewUser() uses selector_expression in the AST
func processUserCrossPackage() {
	user := models.NewUser("bob")
	user.Save()
}

func GetRepo(name string) *models.Repo {
	return &models.Repo{Name: name}
}

func processRepo() {
	repo := GetRepo("main")
	repo.Save()
}
