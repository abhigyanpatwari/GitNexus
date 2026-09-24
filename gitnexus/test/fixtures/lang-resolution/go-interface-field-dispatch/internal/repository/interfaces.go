package repository

// OrderRepository is satisfied only by types whose methods use POINTER
// receivers (#2813). In Go the method set of *T includes both value- and
// pointer-receiver methods, so *OrderRepo implements this interface even
// though OrderRepo (the value type) does not.
type OrderRepository interface {
	DeleteItem(id string) error
	GetPickQueue(id string) ([]string, error)
	UnsplitOrder(id string) error
}

// PartialRepository is deliberately satisfied by NOTHING in this fixture —
// the negative control for structural detection.
type PartialRepository interface {
	DeleteItem(id string) error
	NeverImplemented(id string) error
}
