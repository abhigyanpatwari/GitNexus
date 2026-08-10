package memory

import "context"

type Mem struct{}

func (m *Mem) Delete(ctx context.Context, id string) error { return nil }

func (m *Mem) Ctx() (context.Context, error) { return nil, nil }

// Same method names, incompatible signatures: still not an implementor.
type Wrong struct{}

func (w *Wrong) Delete(id string) error { return nil }

func (w *Wrong) Ctx() (context.Context, error) { return nil, nil }
