package repository

// MockOrderRepo mirrors the mock proliferation of a real codebase: a second
// pointer-receiver implementor, so the fan-out must reach BOTH.
type MockOrderRepo struct{}

func (m *MockOrderRepo) DeleteItem(id string) error { return nil }

func (m *MockOrderRepo) GetPickQueue(id string) ([]string, error) { return nil, nil }

func (m *MockOrderRepo) UnsplitOrder(id string) error { return nil }

// WrongSigRepo has every method NAME the interface requires, at the same arity,
// but with an incompatible parameter type. It must NOT be detected as an
// implementor — signature comparison is the only guard left now that
// pointer-receiver methods count toward the method set (#2813).
type WrongSigRepo struct{}

func (w *WrongSigRepo) DeleteItem(id int) error { return nil }

func (w *WrongSigRepo) GetPickQueue(id int) ([]string, error) { return nil, nil }

func (w *WrongSigRepo) UnsplitOrder(id int) error { return nil }
