package auth

import "github.com/example/gopkg/internal/models"

func Authenticate(name string) *models.User {
	user := models.NewUser(name)
	return user
}

func ValidateToken(token string) bool {
	return len(token) > 0
}
