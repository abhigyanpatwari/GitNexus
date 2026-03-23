package main

import "example.com/chaincall/models"

type UserService struct{}

func (s *UserService) GetUser() *models.User {
	return &models.User{Name: "alice"}
}

func processUser() {
	svc := &UserService{}
	svc.GetUser().Save()
}
