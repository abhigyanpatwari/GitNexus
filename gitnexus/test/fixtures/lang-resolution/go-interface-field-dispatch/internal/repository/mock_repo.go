package repository

// MockOrderRepo mirrors the mock proliferation of a real codebase: a second
// pointer-receiver implementor, so the fan-out must reach BOTH.
type MockOrderRepo struct{}

func (m *MockOrderRepo) DeleteItem(id string) error { return nil }

func (m *MockOrderRepo) GetPickQueue(id string) ([]string, error) { return nil, nil }

func (m *MockOrderRepo) UnsplitOrder(id string) error { return nil }
