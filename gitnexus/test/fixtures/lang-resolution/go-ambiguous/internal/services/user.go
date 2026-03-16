package services

import "github.com/example/ambiguous/internal/models"

type UserHandler struct {
	models.Handler
}

func (u *UserHandler) Run() {}
