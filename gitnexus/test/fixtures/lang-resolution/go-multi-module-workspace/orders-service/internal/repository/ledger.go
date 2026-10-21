package repository

// Ledger shares its name, package path tail and Save with billing's: for a
// Save call, only the module that owns the import tells the two apart.
type Ledger struct{}

func (s *Ledger) Save() error { return nil }

func (s *Ledger) ReserveStock(sku string) error { return nil }
