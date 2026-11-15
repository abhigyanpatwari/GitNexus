package repository

// A nested module: its own go.mod removes this tree from example.com/platform,
// so the root module's internal/repository never includes this file.
type Ledger struct{}

func (s *Ledger) Save() error { return nil }
