package main

import (
	"example.com/platform/internal/repository"
	"example.com/platform/pkg/clock"
)

func Serve(ledger *repository.Ledger, clk *clock.Clock) error {
	clk.Tick()
	return ledger.Save()
}
