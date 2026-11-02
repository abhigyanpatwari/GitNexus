package api

// Collides with vault.Vault, method name included.
type Vault struct {
	Slots int
}

func (v *Vault) Stow() int {
	return v.Slots
}
