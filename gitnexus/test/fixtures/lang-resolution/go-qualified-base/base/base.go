package base

// Base types embedded cross-package by the consumers package. Struct bases
// produce EXTENDS; the interface base produces IMPLEMENTS (the split is decided
// downstream from the resolved target's symbol kind).

type Base struct {
	ID int
}

func (b *Base) Describe() string {
	return "base"
}

// Box is a generic struct embedded as `base.Box[int]` (generic_type wrapping a
// qualified_type) — the previously DROPPED qualified-generic embed shape.
type Box[T any] struct {
	value T
}

// Reader is embedded into a consumer interface as `base.Reader` (qualified
// interface embed) — previously DROPPED because the synth never walked
// interface_type bodies.
type Reader interface {
	Read() (int, error)
}
