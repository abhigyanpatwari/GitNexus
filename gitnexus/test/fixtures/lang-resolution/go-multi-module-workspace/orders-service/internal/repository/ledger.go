package repository

// Ledger shares its name, its package path tail and its method names with
// billing's: only the module that owns the import tells the two apart.
type Ledger struct{}

func (s *Ledger) Save() error { return nil }

func (s *Ledger) ReserveStock(sku string) error { return nil }
