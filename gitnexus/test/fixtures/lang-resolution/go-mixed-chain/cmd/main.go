package main

import "example.com/go-mixed-chain/models"

func processWithService(svc *models.UserService) {
	svc.GetUser().Address.Save()
}

func processWithUser(user *models.User) {
	user.GetAddress().City.GetName()
}
