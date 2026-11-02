package services

import m "example.com/go-qualified-declared-types/models"

func ArchiveAliased(u m.User) bool {
	return u.Archive()
}
