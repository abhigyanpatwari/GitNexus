package main

import (
	"github.com/example/gopkg/internal/auth"
	"github.com/example/gopkg/internal/models"
)

func main() {
	user := auth.Authenticate("alice")
	_ = models.NewUser("bob")
	_ = models.NewAdmin("charlie", "superadmin")
	_ = user
}
