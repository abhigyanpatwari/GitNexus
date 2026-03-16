package main

import "example.com/go-member-calls/models"

func processUser() bool {
	user := models.User{}
	return user.Save()
}
