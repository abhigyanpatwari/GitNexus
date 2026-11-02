package main

import "github.com/acme/billing/internal/repository"

func ChargeOrder(ledger *repository.Ledger) error {
	if err := ledger.ChargeCard(42); err != nil {
		return err
	}
	return ledger.Save()
}
