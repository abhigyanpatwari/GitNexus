package services

import "example.com/go-qualified-declared-types/models"

func ArchiveDeclared() bool {
	var u models.User
	return u.Archive()
}

func ArchiveConstructed() bool {
	u := &models.User{Name: "n"}
	return u.Archive()
}
