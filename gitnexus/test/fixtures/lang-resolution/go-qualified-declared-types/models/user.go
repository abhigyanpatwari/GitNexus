package models

type Mailbox struct {
	Unread int
}

func (m *Mailbox) Purge() int {
	return m.Unread
}

type User struct {
	Name  string
	Inbox Mailbox
}

func (u *User) Archive() bool {
	return u.Name != ""
}
