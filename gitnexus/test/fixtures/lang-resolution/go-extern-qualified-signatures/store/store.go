package store

import (
	"context"

	"github.com/foo/bar/v2"
)

// Every method here names a type from OUTSIDE the repository. Before #2873 that
// alone was enough to make structural satisfaction fail.
type Store interface {
	Delete(ctx context.Context, id string) error
	Ctx() (context.Context, error)
	// Imported as `bar`, not `v2`: the local name Go uses for a v2+ module is
	// the segment BEFORE the major version.
	Configure(cfg bar.Config) error
}
