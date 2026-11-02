package main

import "github.com/acme/orders/internal/repository"

func PlaceOrder(ledger *repository.Ledger) error {
	if err := ledger.ReserveStock("sku-1"); err != nil {
		return err
	}
	return ledger.Save()
}
