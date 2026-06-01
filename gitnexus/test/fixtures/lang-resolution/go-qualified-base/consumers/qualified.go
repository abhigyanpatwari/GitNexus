package consumers

import "example.com/app/base"

// Qualified struct embed `pkg.Base` (qualified_type) — previously DROPPED by the
// registry-primary synth (it rejected anything but a bare type_identifier).
// Resolves to the struct base.Base → EXTENDS S → Base.
type S struct {
	base.Base
}

// Pointer-qualified struct embed `*pkg.Base`. The `*` is an unnamed token, so
// field_declaration.type is already the qualified_type — same shape as S.
// → EXTENDS P → Base.
type P struct {
	*base.Base
}

// Qualified-generic struct embed `pkg.Box[T]` (generic_type wrapping a
// qualified_type). Reduces to the bare base name `Box`. → EXTENDS G → Box.
type G struct {
	base.Box[int]
}

// Qualified interface embed `pkg.Reader` inside an interface body
// (interface_type → type_elem). The synth now walks interface bodies. The
// target base.Reader is an interface → IMPLEMENTS R → Reader.
type R interface {
	base.Reader
}
