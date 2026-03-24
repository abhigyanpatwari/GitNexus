package main

import "example.com/callresult/models"

func GetUser(name string) *models.User {
	return &models.User{Name: name}
}

func processUser() {
	user := GetUser("alice")
	user.Save()
}
