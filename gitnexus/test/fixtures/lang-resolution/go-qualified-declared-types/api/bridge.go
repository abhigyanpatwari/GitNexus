package api

import "example.com/go-qualified-declared-types/models"

// The qualifier names models.User even though this package declares a User
// of its own.
func Forward(u models.User) bool {
	return u.Archive()
}
