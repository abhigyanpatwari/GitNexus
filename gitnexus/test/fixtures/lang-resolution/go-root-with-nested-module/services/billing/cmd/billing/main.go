package main

import "github.com/acme/ledger/internal/repository"

func Bill(ledger *repository.Ledger) error {
	return ledger.Save()
}
