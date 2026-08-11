package alpha

import "example.com/alpha-vendor/client"

// `client` here and `client` in package beta are DIFFERENT out-of-repo packages
// that happen to share a last path segment.
type Dialer interface {
	Dial(cfg client.Config) error
}
