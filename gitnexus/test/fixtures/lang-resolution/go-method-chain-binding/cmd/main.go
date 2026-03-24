package main

import "example.com/methodchain/models"

func GetUser() *models.User {
	return &models.User{}
}

func processChain() {
	user := GetUser()
	addr := user.Address
	city := addr.GetCity()
	city.Save()
}
