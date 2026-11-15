package services

import "example.com/go-qualified-declared-types/vault"

// Each receiver below is named like its type's package. The qualifier in its
// type still names the import: Go resolves a parameter's or local's type
// before the name is in scope, and struct fields are never in lexical scope.
type Keeper struct {
	vault *vault.Vault
}

func (k *Keeper) StowField() int {
	return k.vault.Stow()
}

func StowParam(vault *vault.Vault) int {
	return vault.Stow()
}

func StowLocal() int {
	var vault vault.Vault
	return vault.Stow()
}
