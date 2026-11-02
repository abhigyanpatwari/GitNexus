package api

// Same type names and method names as package models: only the package
// qualifier at the use site says which one a receiver means.
type Mailbox struct {
	Pending int
}

func (m *Mailbox) Purge() int {
	return m.Pending
}

type User struct {
	Handle string
	Inbox  Mailbox
}

func (u *User) Archive() bool {
	return u.Handle != ""
}
