package services

import (
	"example.com/go-qualified-declared-types/api"
	"example.com/go-qualified-declared-types/models"
)

type Archiver struct {
	member  models.User
	pointer *models.User
	remote  api.User
}

func ArchiveByValue(u models.User) bool {
	return u.Archive()
}

func ArchiveByPointer(u *models.User) bool {
	return u.Archive()
}

func PurgeInbox(u models.User) int {
	return u.Inbox.Purge()
}

func (a *Archiver) ArchiveMember() bool {
	return a.member.Archive()
}

func (a *Archiver) ArchivePointer() bool {
	return a.pointer.Archive()
}

func (a *Archiver) ArchiveRemote() bool {
	return a.remote.Archive()
}
