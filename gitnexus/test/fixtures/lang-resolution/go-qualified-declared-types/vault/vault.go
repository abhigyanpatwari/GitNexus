package vault

type Vault struct {
	Items int
}

func (v *Vault) Stow() int {
	return v.Items
}
