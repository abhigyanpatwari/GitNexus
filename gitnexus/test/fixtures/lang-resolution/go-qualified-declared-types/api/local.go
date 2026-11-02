package api

// A bare, same-package spelling: `User` here is api.User.
func ArchiveLocal(u User) bool {
	return u.Archive()
}
