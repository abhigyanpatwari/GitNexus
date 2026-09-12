package memory

import (
	"context"

	"github.com/foo/bar/v2"
)

type Mem struct{}

func (m *Mem) Delete(ctx context.Context, id string) error { return nil }

func (m *Mem) Ctx() (context.Context, error) { return nil, nil }

func (m *Mem) Configure(cfg bar.Config) error { return nil }

// Same method names, incompatible signatures: still not an implementor.
type Wrong struct{}

func (w *Wrong) Delete(id string) error { return nil }

func (w *Wrong) Ctx() (context.Context, error) { return nil, nil }

func (w *Wrong) Configure(cfg bar.Config) error { return nil }
