package repository

// Thing is an interface-typed dependency, the shape a DI-wired Go service
// stores in a struct field.
type Thing interface {
	DoWork() error
}

// Impl is the concrete implementation behind Thing.
type Impl struct{}

func (i *Impl) DoWork() error { return nil }

// CartRepo is a concrete-typed dependency reached through a struct field.
type CartRepo struct{}

func (c *CartRepo) WithTx(tx int) *CartRepo { return c }
