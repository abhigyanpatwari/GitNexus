package repository

type Ledger struct{}

func (s *Ledger) Save() error { return nil }

func (s *Ledger) ChargeCard(amount int) error { return nil }
