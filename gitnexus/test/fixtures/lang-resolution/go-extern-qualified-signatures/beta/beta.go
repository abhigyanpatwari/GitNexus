package beta

import "example.com/beta-vendor/client"

type BetaDialer struct{}

func (b *BetaDialer) Dial(cfg client.Config) error { return nil }
