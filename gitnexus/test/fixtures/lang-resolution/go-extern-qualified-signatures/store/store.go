package store

import "context"

// Every method here names a type from OUTSIDE the repository. Before #2873 that
// alone was enough to make structural satisfaction fail.
type Store interface {
	Delete(ctx context.Context, id string) error
	Ctx() (context.Context, error)
}
